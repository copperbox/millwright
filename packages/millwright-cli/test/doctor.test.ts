import { generateKeyPairSync } from 'node:crypto';
import { GetRepositoryPolicyCommand } from '@aws-sdk/client-ecr';
import { GetAccountSummaryCommand, ListRolesCommand } from '@aws-sdk/client-iam';
import { ListServiceQuotasCommand } from '@aws-sdk/client-service-quotas';
import {
  refMapKey,
  registryKey,
  serializeGithubCredentials,
  serializeRepoConfig,
  defaultRepoConfig,
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
  return { deps, lines };
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

  it('FAILS (not warns) on a polled repo with no default-branch registry entry, naming the remedy', async () => {
    const { deps, lines } = fixture({ withRegistryEntry: false });
    const report = await doctor(deps, {});
    expect(report.failed).toBe(1);
    const text = lines.join('\n');
    expect(text).toContain(`[FAIL] registry ${REPO}`);
    expect(text).toMatch(/polled but has no default-branch registry entry/);
    expect(text).toContain(`Re-run "millwright repo add ${REPO}"`);
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
