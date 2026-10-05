import { generateKeyPairSync } from 'node:crypto';
import { GetRepositoryPolicyCommand } from '@aws-sdk/client-ecr';
import { GetAccountSummaryCommand, ListRolesCommand } from '@aws-sdk/client-iam';
import { ListServiceQuotasCommand } from '@aws-sdk/client-service-quotas';
import { DescribeExecutionCommand } from '@aws-sdk/client-sfn';
import {
  executionArn,
  refMapKey,
  registryKey,
  serializeGithubCredentials,
  serializeRepoConfig,
  defaultRepoConfig,
  synthExecutionName,
} from '@copperbox/millwright-state';
import { describe, expect, it } from 'vitest';
import { DoctorDeps, doctor } from '../src/doctor';
import { FetchLike } from '../src/github/rest';
import { FakeDdb } from './fake-ddb';
import { FakeSsm } from './fake-ssm';

const STATE_TABLE = 'millwright-prod-state';
const POLLING_TABLE = 'millwright-prod-polling';
const REPO = 'acme/api';
const SHA = 'c0ffee0000000000000000000000000000000000';
const NOW = () => new Date('2026-08-12T09:00:00Z');
const RUN_EXECUTOR = 'arn:aws:states:eu-west-1:123456789012:stateMachine:millwright-prod-run-executor';
const BOOTSTRAP_ARN = executionArn(RUN_EXECUTOR, synthExecutionName(REPO, 'refs/heads/main', SHA))!;

/** What DescribeExecution reports for the default-branch bootstrap synth. */
type BootstrapFixture =
  | 'missing'
  | 'denied'
  | { status: string; stopDate?: Date };

const APP_KEY = generateKeyPairSync('rsa', { modulusLength: 2048 })
  .privateKey.export({ type: 'pkcs1', format: 'pem' })
  .toString();

interface GithubFixture {
  appOk?: boolean;
  installed?: boolean;
  pullsStatus?: number;
  rulesets?: Array<{ name: string; target: string; enforcement: string }>;
}

function githubFetch(fixture: GithubFixture): FetchLike {
  return async (url, init) => {
    const respond = (status: number, json: unknown) => ({
      ok: status < 300,
      status,
      text: async () => JSON.stringify(json),
    });
    if (url.endsWith('/app')) {
      return fixture.appOk === false
        ? respond(401, { message: 'bad credentials' })
        : respond(200, { slug: 'millwright-prod' });
    }
    if (url.endsWith(`/repos/${REPO}/installation`)) {
      return fixture.installed === false
        ? respond(404, { message: 'Not Found' })
        : respond(200, { id: 77 });
    }
    if (url.includes('/access_tokens')) {
      return respond(201, { token: 'ghs_mem_only', expires_at: '2026-08-12T10:00:00Z' });
    }
    if (url.includes(`/repos/${REPO}/pulls`)) {
      const status = fixture.pullsStatus ?? 200;
      return status < 300 ? respond(status, []) : respond(status, { message: 'forbidden' });
    }
    if (url.endsWith(`/repos/${REPO}/rulesets`)) {
      return respond(200, fixture.rulesets ?? [{ name: 'protect-main', target: 'branch', enforcement: 'active' }]);
    }
    throw new Error(`unexpected fetch ${init?.method ?? 'GET'} ${url}`);
  };
}

interface FixtureOptions {
  /** @default 'missing' (no bootstrap execution exists yet) */
  bootstrap?: BootstrapFixture;
  /** @default true — the manifest names the run executor state machine */
  withRunExecutor?: boolean;
  github?: GithubFixture;
  withCredentials?: boolean;
  withDeployKey?: boolean;
  withRefMap?: boolean;
  withRegistryEntry?: boolean;
  lastTickAt?: string | null;
  breakerOpen?: boolean;
  headError?: string;
  secretsRefs?: string[];
  ecrRepos?: string[];
}

function fixture(options: FixtureOptions = {}) {
  const ssm = new FakeSsm();
  ssm.setManifest('prod', {
    stateTable: STATE_TABLE,
    pollingTable: POLLING_TABLE,
    artifactBucket: 'millwright-prod-artifacts',
    buildLogGroup: '/millwright/prod/builds',
    eventBus: 'millwright-prod-bus',
    ...(options.withRunExecutor === false ? {} : { runExecutor: RUN_EXECUTOR }),
  });
  if (options.withCredentials !== false) {
    ssm.set(
      '/millwright/prod/github/app',
      serializeGithubCredentials({ mode: 'app', appId: 42, slug: 'millwright-prod', privateKeyPem: APP_KEY }),
      'SecureString',
    );
  }
  ssm.set(
    '/millwright/prod/github/host-keys',
    `github.com ssh-ed25519 ${Buffer.from('pin').toString('base64')}`,
  );
  ssm.set(
    `/millwright/prod/repos/${REPO}/config`,
    serializeRepoConfig({
      ...defaultRepoConfig(),
      secretsAllowedRefs: options.secretsRefs ?? ['main'],
      ecrPullRepos: options.ecrRepos ?? [],
    }),
  );
  if (options.withDeployKey !== false) {
    ssm.set(`/millwright/prod/repos/${REPO}/deploy-key`, 'FAKE-PRIVATE-KEY', 'SecureString');
  }

  const ddb = new FakeDdb();
  if (options.lastTickAt !== null) {
    ddb.put(POLLING_TABLE, {
      ...CIRCUIT,
      lastTickAt: options.lastTickAt ?? '2026-08-12T08:59:30Z',
      lastTickDurationMs: 7400,
      ...(options.breakerOpen ? { open: true } : {}),
    });
  }
  if (options.withRefMap !== false) {
    ddb.put(POLLING_TABLE, { ...refMapKey(REPO), refs: 'compressed' });
  }
  if (options.withRegistryEntry !== false) {
    ddb.put(STATE_TABLE, {
      ...registryKey(REPO, 'refs/heads/main'),
      repo: REPO,
      ref: 'refs/heads/main',
      schemaVersion: 1,
      workflows: { ci: { triggers: {} } },
    });
  }

  const lines: string[] = [];
  const sfnCalls: string[] = [];
  const deps: DoctorDeps = {
    ssm,
    ddb,
    iam: {
      send: async (command: unknown) => {
        if (command instanceof GetAccountSummaryCommand) {
          return { SummaryMap: { Roles: 57, RolesQuota: 1000 } };
        }
        if (command instanceof ListRolesCommand) {
          return {
            Roles: [{ RoleName: 'millwright-prod-acme-api-ci-build' }, { RoleName: 'other' }],
            IsTruncated: false,
          };
        }
        throw new Error('unexpected IAM command');
      },
    },
    quotas: {
      send: async (command: unknown) => {
        if (command instanceof ListServiceQuotasCommand) {
          return { Quotas: [{ QuotaName: 'Concurrently running builds for Linux/Small environment', Value: 60 }] };
        }
        throw new Error('unexpected quotas command');
      },
    },
    ecr: {
      send: async (command: unknown) => {
        if (command instanceof GetRepositoryPolicyCommand) {
          const err = new Error('no policy');
          err.name = 'RepositoryPolicyNotFoundException';
          throw err;
        }
        throw new Error('unexpected ECR command');
      },
    },
    sfn: {
      send: async (command: unknown) => {
        if (!(command instanceof DescribeExecutionCommand)) {
          throw new Error('unexpected SFN command');
        }
        sfnCalls.push(command.input.executionArn as string);
        const bootstrap = options.bootstrap ?? 'missing';
        if (bootstrap === 'missing') {
          throw Object.assign(new Error('Execution Does Not Exist'), { name: 'ExecutionDoesNotExist' });
        }
        if (bootstrap === 'denied') {
          throw Object.assign(new Error('not authorized to perform: states:DescribeExecution'), {
            name: 'AccessDeniedException',
          });
        }
        return { executionArn: command.input.executionArn, ...bootstrap };
      },
    },
    fetchLike: githubFetch(options.github ?? {}),
    output: (line) => lines.push(line),
    resolveHead: async () => {
      if (options.headError) {
        throw new Error(options.headError);
      }
      return { branch: 'main', ref: 'refs/heads/main', sha: SHA, empty: false };
    },
    now: NOW,
  };
  return { deps, lines, sfnCalls };
}

const CIRCUIT = { pk: 'CIRCUIT', sk: '-' };

describe('doctor', () => {
  it('passes every check on a healthy deployment', async () => {
    const { deps, lines } = fixture();
    const report = await doctor(deps, {});
    expect(report.failed).toBe(0);
    const text = lines.join('\n');
    expect(text).toContain('[ ok ] github-credentials: App "millwright-prod" (id 42) authenticates');
    expect(text).toContain(`[ ok ] pulls-probe ${REPO}: pull requests readable`);
    expect(text).toContain(`[ ok ] deploy-key ${REPO}: ls-refs reads ${REPO} over SSH (default branch main)`);
    expect(text).toContain('[ ok ] poller: ticking — last tick 30s ago, last tick took 7400 ms');
    expect(text).toContain(`[ ok ] registry ${REPO}: default branch refs/heads/main registered (1 workflow)`);
    expect(text).toContain('[info] iam-quota: 57 of 1000 IAM roles used; 1 millwright-prod-* roles');
    expect(text).toContain('[info] codebuild-quota: account concurrency — Concurrently running builds');
    expect(text).toContain(`[ ok ] rulesets ${REPO}: 1 active branch ruleset`);
    expect(lines.at(-1)).toBe('doctor: all checks passed (10 checks)');
  });

  it('FAILS (not warns) on a polled repo whose bootstrap never started, naming the remedy', async () => {
    const { deps, lines, sfnCalls } = fixture({ withRegistryEntry: false });
    const report = await doctor(deps, {});
    expect(report.failed).toBe(1);
    const text = lines.join('\n');
    expect(text).toContain(`[FAIL] registry ${REPO}`);
    expect(text).toMatch(/polled but has no default-branch registry entry/);
    // Doctor looks the bootstrap synth up under the launcher's deterministic name.
    expect(sfnCalls).toEqual([BOOTSTRAP_ARN]);
    expect(text).toContain('No bootstrap synth has started for c0ffee000000');
    // The repo is already configured (doctor found it via its config parameter), so a
    // bare "repo add" is rejected — the remedy must lead with a push and fall back to
    // an explicit remove-and-re-add that re-supplies the config flags.
    expect(text).toContain('Push to main to prime the registry');
    expect(text).toContain(
      `run "millwright repo remove ${REPO}" then "millwright repo add ${REPO}" with its config flags supplied again`,
    );
    expect(text).toContain('also rotates the deploy key');
    expect(text).not.toContain(`Re-run "millwright repo add ${REPO}"`);
  });

  it('points a failed bootstrap at redrive instead of remove-and-re-add', async () => {
    const stopDate = new Date('2026-08-10T09:00:00Z');
    const { deps, lines } = fixture({
      withRegistryEntry: false,
      bootstrap: { status: 'FAILED', stopDate },
    });
    const report = await doctor(deps, {});
    expect(report.failed).toBe(1);
    const text = lines.join('\n');
    expect(text).toContain(`[FAIL] registry ${REPO}`);
    expect(text).toContain('The bootstrap synth for c0ffee000000 FAILED at 2026-08-10T09:00:00.000Z');
    // Re-adding re-emits the same (repo, ref, sha); SFN refuses the closed execution's name.
    expect(text).toContain('Removing and re-adding the repo will NOT re-synth this commit');
    expect(text).toContain("refuses to reuse a closed execution's name for 90 days");
    expect(text).toContain('Push to main to prime the registry (a new sha is a new execution)');
    expect(text).toContain(
      `redrive it: "aws stepfunctions redrive-execution --execution-arn ${BOOTSTRAP_ARN}"`,
    );
    expect(text).not.toContain(`millwright repo remove ${REPO}`);
  });

  it('says when a failed bootstrap is past the redrive window', async () => {
    const { deps, lines } = fixture({
      withRegistryEntry: false,
      bootstrap: { status: 'TIMED_OUT', stopDate: new Date('2026-07-01T00:00:00Z') },
    });
    await doctor(deps, {});
    const text = lines.join('\n');
    expect(text).toContain('The bootstrap synth for c0ffee000000 TIMED_OUT');
    expect(text).toContain('it stopped more than 14 days ago, so it can no longer be redriven');
    expect(text).not.toContain('redrive-execution');
    expect(text).toContain('Push to main to prime the registry');
  });

  it('warns rather than fails while the bootstrap synth is still running', async () => {
    const { deps, lines } = fixture({ withRegistryEntry: false, bootstrap: { status: 'RUNNING' } });
    const report = await doctor(deps, {});
    expect(report.failed).toBe(0);
    const text = lines.join('\n');
    expect(text).toContain(`[warn] registry ${REPO}`);
    expect(text).toContain('The bootstrap synth for c0ffee000000 is RUNNING; wait for it to finish');
    expect(text).toContain('Do not remove and re-add the repo for this');
  });

  it('flags a succeeded bootstrap that left no registry entry', async () => {
    const { deps, lines } = fixture({ withRegistryEntry: false, bootstrap: { status: 'SUCCEEDED' } });
    const report = await doctor(deps, {});
    expect(report.failed).toBe(1);
    expect(lines.join('\n')).toContain(
      'The bootstrap synth for c0ffee000000 SUCCEEDED yet wrote no registry entry',
    );
  });

  it('still fails with the conditional remedy when the bootstrap state is unreadable', async () => {
    for (const options of [{ bootstrap: 'denied' as const }, { withRunExecutor: false }]) {
      const { deps, lines } = fixture({ withRegistryEntry: false, ...options });
      const report = await doctor(deps, {});
      expect(report.failed).toBe(1);
      const text = lines.join('\n');
      expect(text).toContain(`[FAIL] registry ${REPO}`);
      expect(text).toContain('Could not tell whether a bootstrap synth already ran for c0ffee000000');
      expect(text).toContain('Push to main to prime the registry');
      expect(text).toContain('Only if that bootstrap never started will remove-and-re-add work');
      expect(text).toContain('a failed bootstrap of the same commit must be redriven instead');
    }
    const denied = fixture({ withRegistryEntry: false, bootstrap: 'denied' });
    await doctor(denied.deps, {});
    expect(denied.lines.join('\n')).toContain('DescribeExecution failed: not authorized');
    const legacy = fixture({ withRegistryEntry: false, withRunExecutor: false });
    await doctor(legacy.deps, {});
    expect(legacy.lines.join('\n')).toContain('manifest names no run executor');
  });

  it('warns instead when the repo has never been polled', async () => {
    const { deps, lines } = fixture({ withRegistryEntry: false, withRefMap: false });
    const report = await doctor(deps, {});
    expect(report.failed).toBe(0);
    expect(lines.join('\n')).toContain(`[warn] registry ${REPO}: no polling activity`);
  });

  it('pinpoints the repo whose deploy key is broken', async () => {
    const { deps, lines } = fixture({ headError: 'All configured authentication methods failed' });
    const report = await doctor(deps, {});
    expect(report.failed).toBe(1);
    const text = lines.join('\n');
    expect(text).toContain(
      `[FAIL] deploy-key ${REPO}: the deploy key for ${REPO} cannot read the repo over SSH`,
    );
    expect(text).toContain(`[warn] registry ${REPO}: default branch unknown`);
  });

  it('fails when credentials are missing, naming setup', async () => {
    const { deps, lines } = fixture({ withCredentials: false });
    const report = await doctor(deps, {});
    expect(report.failed).toBeGreaterThan(0);
    expect(lines.join('\n')).toContain('run "millwright setup"');
  });

  it('fails on a missing deploy-key parameter, naming repo add', async () => {
    const { deps, lines } = fixture({ withDeployKey: false });
    const report = await doctor(deps, {});
    expect(report.failed).toBeGreaterThan(0);
    expect(lines.join('\n')).toContain(`re-run "millwright repo add ${REPO}"`);
  });

  it('fails when the poller tick is stale', async () => {
    const { deps, lines } = fixture({ lastTickAt: '2026-08-12T08:00:00Z' });
    const report = await doctor(deps, {});
    expect(report.failed).toBe(1);
    expect(lines.join('\n')).toMatch(/\[FAIL\] poller: last poller tick was 3600s ago/);
  });

  it('fails when the quorum circuit breaker is open', async () => {
    const { deps, lines } = fixture({ breakerOpen: true });
    const report = await doctor(deps, {});
    expect(report.failed).toBe(1);
    expect(lines.join('\n')).toContain('quorum circuit breaker is OPEN');
  });

  it('warns when the poller has never ticked but repos are configured', async () => {
    const { deps, lines } = fixture({ lastTickAt: null, withRefMap: false, withRegistryEntry: false });
    const report = await doctor(deps, {});
    expect(report.failed).toBe(0);
    expect(lines.join('\n')).toContain('[warn] poller: no poller tick recorded');
  });

  it('warns on unprotected secretsAllowedRefs namespaces where readable', async () => {
    const { deps, lines } = fixture({ github: { rulesets: [] } });
    await doctor(deps, {});
    expect(lines.join('\n')).toMatch(/\[warn\] rulesets acme\/api: secretsAllowedRefs \(main\) have no active branch ruleset/);
  });

  it('reports missing ECR resource policies as best-effort info', async () => {
    const { deps, lines } = fixture({
      ecrRepos: ['arn:aws:ecr:eu-west-1:123456789012:repository/tools/builder'],
    });
    await doctor(deps, {});
    expect(lines.join('\n')).toContain(
      '[info] ecr arn:aws:ecr:eu-west-1:123456789012:repository/tools/builder: no resource policy',
    );
  });

  it('fails the pulls probe when the App is not installed on the repo', async () => {
    const { deps, lines } = fixture({ github: { installed: false } });
    const report = await doctor(deps, {});
    expect(report.failed).toBeGreaterThan(0);
    expect(lines.join('\n')).toContain(`[FAIL] pulls-probe ${REPO}: the GitHub App is not installed`);
  });
});
