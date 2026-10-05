/**
 * `millwright doctor` (spec §15, §8.3, §6.1): verify the deployment chain —
 * SSM manifest, GitHub App credentials (including a per-repo pulls probe),
 * deploy keys, poller ticking + last-tick duration — and FAIL, not warn,
 * when a configured repo shows polling activity but no default-branch
 * registry entry, naming the bootstrap remedy. CodeBuild concurrency and
 * IAM quotas plus the job-role count are reported; ECR resource policies
 * and repo rulesets are checked best-effort where readable.
 */

import {
  GithubCredentials,
  RepoConfig,
  configPlaneRoot,
  deployKeyParameterName,
  executionArn,
  executionName,
  githubAppParameterName,
  hostKeysParameterName,
  parseGithubCredentials,
  parseRepoConfig,
  refMapKey,
  repoFromConfigParameterName,
  synthExecutionName,
  CIRCUIT_BREAKER_KEY,
} from '@copperbox/millwright-state';
import { GetRepositoryPolicyCommand } from '@aws-sdk/client-ecr';
import { GetAccountSummaryCommand, ListRolesCommand } from '@aws-sdk/client-iam';
import { ListServiceQuotasCommand } from '@aws-sdk/client-service-quotas';
import { DescribeExecutionCommand } from '@aws-sdk/client-sfn';
import {
  getOptionalParameter,
  listParametersByPrefix,
  manifestResource,
} from './config-plane';
import { Deployment, DiscoverOptions, SsmClientLike, discoverDeployment } from './discovery';
import { DefaultBranchHead, lsRefs, resolveDefaultBranchHead } from './git/ls-refs';
import { parseHostKeyPins, withUploadPack } from './git/ssh';
import { signAppJwt } from './github/app-auth';
import {
  FetchLike,
  createInstallationToken,
  getAuthenticatedApp,
  getRepoInstallationId,
  getTokenIdentity,
  listRepoRulesets,
  probePulls,
} from './github/rest';
import { ResolveHeadOptions } from './repo';
import { DynamoDocClientLike, getPollingItem, getRegistryEntry } from './state-reads';

/** The slice of the IAM / Service Quotas / ECR / Step Functions clients doctor uses. */
export interface AwsClientLike {
  send(command: unknown): Promise<any>;
}

/** Command constructors injected so doctor stays SDK-testable without mocks. */
export interface DoctorDeps {
  readonly ssm: SsmClientLike;
  readonly ddb: DynamoDocClientLike;
  readonly iam: AwsClientLike;
  readonly quotas: AwsClientLike;
  readonly ecr: AwsClientLike;
  readonly sfn: AwsClientLike;
  readonly fetchLike: FetchLike;
  readonly output: (line: string) => void;
  /** Injectable for tests. @default a real SSH ls-refs exchange */
  readonly resolveHead?: (options: ResolveHeadOptions) => Promise<DefaultBranchHead>;
  readonly now?: () => Date;
}

export type CheckStatus = 'ok' | 'info' | 'warn' | 'fail';

export interface DoctorCheck {
  readonly name: string;
  readonly status: CheckStatus;
  readonly detail: string;
}

export interface DoctorReport {
  readonly checks: DoctorCheck[];
  readonly failed: number;
}

const STATUS_LABEL: Record<CheckStatus, string> = {
  ok: '[ ok ]',
  info: '[info]',
  warn: '[warn]',
  fail: '[FAIL]',
};

interface WatchedRepo {
  readonly repo: string;
  readonly config: RepoConfig;
}

async function listWatchedRepos(ssm: SsmClientLike, deployment: Deployment): Promise<WatchedRepo[]> {
  const prefix = `${configPlaneRoot(deployment.name)}/repos/`;
  const repos: WatchedRepo[] = [];
  for (const parameter of await listParametersByPrefix(ssm, prefix)) {
    const repo = repoFromConfigParameterName(deployment.name, parameter.name);
    if (repo) {
      repos.push({ repo, config: parseRepoConfig(parameter.value) });
    }
  }
  return repos.sort((a, b) => a.repo.localeCompare(b.repo));
}

class Checks {
  readonly checks: DoctorCheck[] = [];

  constructor(private readonly output: (line: string) => void) {}

  add(name: string, status: CheckStatus, detail: string): void {
    this.checks.push({ name, status, detail });
    this.output(`${STATUS_LABEL[status]} ${name}: ${detail}`);
  }

  /** Run one check, converting an unexpected throw into a FAIL line. */
  async run(name: string, body: () => Promise<void>): Promise<void> {
    try {
      await body();
    } catch (err) {
      this.add(name, 'fail', (err as Error).message);
    }
  }

  get failed(): number {
    return this.checks.filter((check) => check.status === 'fail').length;
  }
}

function checkManifest(checks: Checks, deployment: Deployment): void {
  checks.add(
    'manifest',
    'ok',
    `deployment "${deployment.name}" — control plane v${deployment.manifest.version}, ` +
      `run-model schema <= ${deployment.manifest.schemaVersion}`,
  );
  for (const [key, what] of [
    ['stateTable', 'state table'],
    ['pollingTable', 'polling table'],
    ['artifactBucket', 'artifact bucket'],
    ['buildLogGroup', 'build log group'],
    ['eventBus', 'event bus'],
  ] as const) {
    if (manifestResource(deployment, key) === undefined) {
      checks.add(
        'manifest',
        'warn',
        `no ${what} ("${key}") in the manifest — that component is not provisioned yet`,
      );
    }
  }
}

interface GithubAuth {
  readonly credentials: GithubCredentials;
  /** Mint (or reuse) a token able to read one repo; undefined = not possible. */
  readonly repoToken: (repo: string) => Promise<string | undefined>;
}

async function checkGithubCredentials(
  checks: Checks,
  deps: DoctorDeps,
  deployment: Deployment,
): Promise<GithubAuth | undefined> {
  const parameter = githubAppParameterName(deployment.name);
  const raw = await getOptionalParameter(deps.ssm, parameter, { decrypt: true });
  if (raw === undefined) {
    checks.add('github-credentials', 'fail', `no credentials at ${parameter} — run "millwright setup"`);
    return undefined;
  }
  const credentials = parseGithubCredentials(raw);
  const now = deps.now ?? (() => new Date());
  if (credentials.mode === 'pat') {
    const identity = await getTokenIdentity(deps.fetchLike, credentials.token);
    checks.add('github-credentials', 'ok', `PAT credentials valid (${identity.login})`);
    return { credentials, repoToken: async () => credentials.token };
  }
  const jwt = () =>
    signAppJwt(credentials.appId, credentials.privateKeyPem, Math.floor(now().getTime() / 1000));
  const app = await getAuthenticatedApp(deps.fetchLike, jwt());
  checks.add('github-credentials', 'ok', `App "${app.slug}" (id ${credentials.appId}) authenticates`);
  const tokens = new Map<string, string | undefined>();
  return {
    credentials,
    repoToken: async (repo: string) => {
      if (!tokens.has(repo)) {
        const installationId = await getRepoInstallationId(deps.fetchLike, jwt(), repo);
        tokens.set(
          repo,
          installationId === undefined
            ? undefined
            : (await createInstallationToken(deps.fetchLike, jwt(), installationId)).token,
        );
      }
      return tokens.get(repo);
    },
  };
}

async function checkPullsProbe(
  checks: Checks,
  deps: DoctorDeps,
  auth: GithubAuth,
  repo: WatchedRepo,
): Promise<void> {
  const name = `pulls-probe ${repo.repo}`;
  const token = await auth.repoToken(repo.repo);
  if (token === undefined) {
    checks.add(
      name,
      'fail',
      `the GitHub App is not installed on ${repo.repo} — install it, or PR polling and ` +
        'check reporting cannot work',
    );
    return;
  }
  await probePulls(deps.fetchLike, token, repo.repo);
  checks.add(name, 'ok', 'pull requests readable (tier-2 PR polling permission present)');
}

async function checkDeployKey(
  checks: Checks,
  deps: DoctorDeps,
  deployment: Deployment,
  repo: WatchedRepo,
  hostKeyPins: readonly Buffer[],
): Promise<DefaultBranchHead | undefined> {
  const name = `deploy-key ${repo.repo}`;
  const parameter = deployKeyParameterName(deployment.name, repo.repo);
  const privateKey = await getOptionalParameter(deps.ssm, parameter, { decrypt: true });
  if (privateKey === undefined) {
    checks.add(
      name,
      'fail',
      `no deploy key at ${parameter} — re-run "millwright repo add ${repo.repo}"`,
    );
    return undefined;
  }
  const resolveHead =
    deps.resolveHead ??
    (async (options: ResolveHeadOptions) =>
      resolveDefaultBranchHead(
        await withUploadPack(options, (stream) => lsRefs(stream, { refPrefixes: ['HEAD'] })),
      ));
  try {
    const head = await resolveHead({ repo: repo.repo, privateKey, hostKeyPins });
    checks.add(
      name,
      'ok',
      `ls-refs reads ${repo.repo} over SSH` +
        (head.branch ? ` (default branch ${head.branch})` : ''),
    );
    return head;
  } catch (err) {
    checks.add(
      name,
      'fail',
      `the deploy key for ${repo.repo} cannot read the repo over SSH ` +
        `(${(err as Error).message}) — reinstall it with "millwright repo add"`,
    );
    return undefined;
  }
}

/**
 * Poller-health contract (written by the poller each tick): the polling
 * table's circuit-breaker item carries `lastTickAt` (ISO-8601),
 * `lastTickDurationMs`, and `open` when the quorum breaker tripped (§6.3).
 */
async function checkPoller(
  checks: Checks,
  deps: DoctorDeps,
  deployment: Deployment,
  repoCount: number,
): Promise<void> {
  const table = manifestResource(deployment, 'pollingTable');
  if (table === undefined) {
    checks.add('poller', 'warn', 'no polling table in the manifest — poller not provisioned yet');
    return;
  }
  const item = await getPollingItem(deps.ddb, table, CIRCUIT_BREAKER_KEY);
  const lastTickAt = typeof item?.lastTickAt === 'string' ? item.lastTickAt : undefined;
  if (item === undefined || lastTickAt === undefined) {
    checks.add(
      'poller',
      repoCount > 0 ? 'warn' : 'info',
      repoCount > 0
        ? 'no poller tick recorded — the poller has never run (deploy pending, or it is broken)'
        : 'no poller tick recorded; no repos are configured yet',
    );
    return;
  }
  if (item.open) {
    checks.add('poller', 'fail', 'quorum circuit breaker is OPEN — SSH transport to GitHub is failing');
    return;
  }
  const now = deps.now ?? (() => new Date());
  const cadenceSeconds =
    typeof deployment.manifest.pollCadenceSeconds === 'number'
      ? deployment.manifest.pollCadenceSeconds
      : 60;
  const ageSeconds = Math.round((now().getTime() - Date.parse(lastTickAt)) / 1000);
  const duration =
    typeof item.lastTickDurationMs === 'number' ? `, last tick took ${item.lastTickDurationMs} ms` : '';
  if (ageSeconds > cadenceSeconds * 3) {
    checks.add(
      'poller',
      'fail',
      `last poller tick was ${ageSeconds}s ago (cadence ${cadenceSeconds}s) — the poller looks stopped`,
    );
    return;
  }
  checks.add('poller', 'ok', `ticking — last tick ${ageSeconds}s ago${duration}`);
}

/** How long Step Functions reserves a closed execution's name. */
const EXECUTION_NAME_RESERVED_DAYS = 90;

type BootstrapState =
  | { kind: 'unknown'; reason: string }
  | { kind: 'never-started' }
  | { kind: 'running'; status: string }
  | { kind: 'succeeded' }
  | { kind: 'closed'; status: string; stopDate: Date | undefined };

/**
 * The operator command that synths `sha` again at the same commit: a fresh
 * synth-only execution of the run executor with the launcher's exact input,
 * under a name the launcher never derives (so the reserved bootstrap name is
 * not in the way). Redrive cannot do this: Synth and PostSynth catch every
 * error into the terminal `SynthFailed` Fail state, and a redrive re-enters
 * the state that failed, so the redriven execution fails again without
 * starting a synth job.
 */
function resynthCommand(
  stateMachineArn: string,
  repo: string,
  ref: string,
  sha: string,
  now: Date,
): string {
  const name = executionName(
    'synth',
    `${repo}-${sha.slice(0, 12)}-retry`,
    `${repo}#${ref}#${sha}#${now.toISOString()}`,
  );
  const input = JSON.stringify({ action: 'synth-only', repo, ref, sha });
  return (
    `aws stepfunctions start-execution --state-machine-arn ${stateMachineArn} ` +
    `--name ${name} --input '${input}'`
  );
}

/**
 * Where the default-branch bootstrap synth for `sha` stands. The launcher
 * starts it under the deterministic name `synthExecutionName` derives, so
 * doctor can describe it by name instead of listing executions.
 */
async function describeBootstrap(
  deps: DoctorDeps,
  deployment: Deployment,
  repo: string,
  ref: string,
  sha: string,
): Promise<BootstrapState> {
  const stateMachineArn = manifestResource(deployment, 'runExecutor');
  const arn =
    stateMachineArn === undefined
      ? undefined
      : executionArn(stateMachineArn, synthExecutionName(repo, ref, sha));
  if (arn === undefined) {
    return { kind: 'unknown', reason: 'manifest names no run executor (deployment predates it)' };
  }
  let execution: { status?: string; stopDate?: Date };
  try {
    execution = await deps.sfn.send(new DescribeExecutionCommand({ executionArn: arn }));
  } catch (err) {
    if ((err as { name?: string })?.name === 'ExecutionDoesNotExist') {
      return { kind: 'never-started' };
    }
    return { kind: 'unknown', reason: `DescribeExecution failed: ${(err as Error).message}` };
  }
  const status = execution.status ?? 'UNKNOWN';
  if (status === 'RUNNING' || status === 'PENDING_REDRIVE') {
    return { kind: 'running', status };
  }
  if (status === 'SUCCEEDED') {
    return { kind: 'succeeded' };
  }
  return { kind: 'closed', status, stopDate: execution.stopDate };
}

/**
 * The §8.3 gate: a configured repo with polling activity but no
 * default-branch registry entry is a hard FAIL naming the remedy. Every repo
 * doctor inspects was found via its config parameter, so a bare "repo add" is
 * rejected as already configured.
 *
 * The remedy depends on the bootstrap synth's state. Pushing to the default
 * branch always works: a new sha is a new execution. Remove-and-re-add only
 * works while the bootstrap for the current head has never started: `repo
 * add` emits a bootstrap event for the same (repo, ref, sha), the launcher
 * derives the same execution name, and Step Functions reserves a closed
 * execution's name for 90 days, so the restart is swallowed as
 * ExecutionAlreadyExists and the registry stays empty. For a failed bootstrap
 * the way back at the same commit is a fresh synth-only execution under a new
 * name, which doctor prints ready to run (`resynthCommand`); redrive would
 * only re-enter the SynthFailed state.
 */
async function checkRegistry(
  checks: Checks,
  deps: DoctorDeps,
  deployment: Deployment,
  repo: WatchedRepo,
  head: DefaultBranchHead | undefined,
): Promise<void> {
  const name = `registry ${repo.repo}`;
  const stateTable = manifestResource(deployment, 'stateTable');
  const pollingTable = manifestResource(deployment, 'pollingTable');
  if (stateTable === undefined || pollingTable === undefined) {
    checks.add(name, 'warn', 'state/polling table not provisioned — cannot check the registry');
    return;
  }
  const defaultRef = head?.ref;
  if (defaultRef === undefined) {
    checks.add(
      name,
      'warn',
      'default branch unknown (deploy-key check did not resolve it) — registry not checked',
    );
    return;
  }
  const entry = await getRegistryEntry(deps.ddb, stateTable, repo.repo, defaultRef);
  if (entry !== undefined) {
    const workflows = Object.keys(entry.workflows ?? {});
    checks.add(
      name,
      'ok',
      `default branch ${defaultRef} registered (${workflows.length} workflow${workflows.length === 1 ? '' : 's'})`,
    );
    return;
  }
  const polled = (await getPollingItem(deps.ddb, pollingTable, refMapKey(repo.repo))) !== undefined;
  if (polled) {
    const now = deps.now ?? (() => new Date());
    const branch = head?.branch ?? defaultRef;
    const problem =
      `${repo.repo} is being polled but has no default-branch registry entry — its pushes ` +
      `cannot match any workflow. `;
    const push = `Push to ${branch} to prime the registry`;
    const readd =
      `run "millwright repo remove ${repo.repo}" then "millwright repo add ${repo.repo}" ` +
      `with its config flags supplied again (this also rotates the deploy key)`;
    const sha = head?.sha;
    const bootstrap =
      sha === undefined
        ? { kind: 'unknown' as const, reason: 'default-branch head sha unknown' }
        : await describeBootstrap(deps, deployment, repo.repo, defaultRef, sha);
    const short = sha?.slice(0, 12) ?? '?';
    const stateMachineArn = manifestResource(deployment, 'runExecutor');
    const resynth =
      stateMachineArn === undefined || sha === undefined
        ? undefined
        : resynthCommand(stateMachineArn, repo.repo, defaultRef, sha, now());
    switch (bootstrap.kind) {
      case 'never-started':
        checks.add(
          name,
          'fail',
          `${problem}No bootstrap synth has started for ${short}. ${push}; if you cannot push, ${readd}`,
        );
        return;
      case 'running':
        checks.add(
          name,
          'warn',
          `${problem}The bootstrap synth for ${short} is ${bootstrap.status}; wait for it to finish ` +
            `and run doctor again. Do not remove and re-add the repo for this`,
        );
        return;
      case 'succeeded':
        checks.add(
          name,
          'fail',
          `${problem}The bootstrap synth for ${short} SUCCEEDED yet wrote no registry entry — ` +
            `inspect the run executor's execution for ${short}. ${push}`,
        );
        return;
      case 'closed': {
        const stopped =
          bootstrap.stopDate === undefined ? '' : ` at ${bootstrap.stopDate.toISOString()}`;
        checks.add(
          name,
          'fail',
          `${problem}The bootstrap synth for ${short} ${bootstrap.status}${stopped}. ` +
            `Removing and re-adding the repo will NOT re-synth this commit: "repo add" emits the same ` +
            `(repo, ref, sha) bootstrap and Step Functions refuses to reuse a closed execution's ` +
            `name for ${EXECUTION_NAME_RESERVED_DAYS} days. Redriving it will NOT re-synth either: ` +
            `it ended in the SynthFailed state and a redrive re-enters that state. Fix the cause ` +
            `(the synth logs are in the builds log group), then ${push} (a new sha is a new ` +
            `execution), or synth this commit again under a new execution name: ` +
            `${resynth ?? 'see the operations runbook'}`,
        );
        return;
      }
      case 'unknown': {
        const retry =
          resynth === undefined
            ? 'a failed bootstrap of the same commit needs a fresh synth-only execution of the run ' +
              'executor under a new name (see the operations runbook); redriving it does not re-synth'
            : 'a failed bootstrap of the same commit needs a fresh synth-only execution under a new ' +
              `name (redriving it does not re-synth): ${resynth}`;
        checks.add(
          name,
          'fail',
          `${problem}Could not tell whether a bootstrap synth already ran for ${short} ` +
            `(${bootstrap.reason}). ${push}. Only if that bootstrap never started will ` +
            `remove-and-re-add work: ${readd}; ${retry}`,
        );
        return;
      }
    }
  }
  checks.add(
    name,
    'warn',
    'no polling activity and no registry entry yet — expected right after onboarding',
  );
}

async function checkQuotas(checks: Checks, deps: DoctorDeps, deployment: Deployment): Promise<void> {
  try {
    const concurrency: string[] = [];
    let nextToken: string | undefined;
    do {
      const page = await deps.quotas.send(
        new ListServiceQuotasCommand({ ServiceCode: 'codebuild', NextToken: nextToken }),
      );
      for (const quota of page.Quotas ?? []) {
        if (
          typeof quota.QuotaName === 'string' &&
          /concurrently running/i.test(quota.QuotaName) &&
          typeof quota.Value === 'number'
        ) {
          concurrency.push(`${quota.QuotaName}: ${quota.Value}`);
        }
      }
      nextToken = page.NextToken;
    } while (nextToken);
    checks.add(
      'codebuild-quota',
      'info',
      concurrency.length
        ? `account concurrency — ${concurrency.join('; ')} (millwright queues, never fails, on exhaustion)`
        : 'no CodeBuild concurrency quotas visible in this region',
    );
  } catch (err) {
    checks.add('codebuild-quota', 'info', `not readable (${(err as Error).message})`);
  }

  try {
    const summary = await deps.iam.send(new GetAccountSummaryCommand({}));
    const roles = summary.SummaryMap?.Roles;
    const quota = summary.SummaryMap?.RolesQuota;
    let jobRoles = 0;
    let marker: string | undefined;
    do {
      const page = await deps.iam.send(new ListRolesCommand({ Marker: marker }));
      for (const role of page.Roles ?? []) {
        if (typeof role.RoleName === 'string' && role.RoleName.startsWith(`millwright-${deployment.name}-`)) {
          jobRoles++;
        }
      }
      marker = page.IsTruncated ? page.Marker : undefined;
    } while (marker);
    checks.add(
      'iam-quota',
      'info',
      `${roles ?? '?'} of ${quota ?? '?'} IAM roles used; ${jobRoles} millwright-${deployment.name}-* roles ` +
        '(stable per repo × workflow × job, two variants — §10.2)',
    );
  } catch (err) {
    checks.add('iam-quota', 'info', `not readable (${(err as Error).message})`);
  }
}

const ECR_ARN_PATTERN = /^arn:[^:]+:ecr:[^:]*:(\d*):repository\/(.+)$/;

async function checkEcrPolicies(
  checks: Checks,
  deps: DoctorDeps,
  repos: readonly WatchedRepo[],
): Promise<void> {
  const arns = [...new Set(repos.flatMap((repo) => repo.config.ecrPullRepos))].sort();
  if (arns.length === 0) {
    return;
  }
  for (const arn of arns) {
    const name = `ecr ${arn}`;
    const match = arn.match(ECR_ARN_PATTERN);
    if (!match) {
      checks.add(name, 'warn', 'not an ECR repository ARN — jobs cannot pull from it');
      continue;
    }
    try {
      await deps.ecr.send(
        new GetRepositoryPolicyCommand({
          repositoryName: match[2],
          ...(match[1] ? { registryId: match[1] } : {}),
        }),
      );
      checks.add(name, 'ok', 'repository reachable, resource policy present');
    } catch (err) {
      const kind = (err as { name?: string }).name ?? '';
      if (kind === 'RepositoryPolicyNotFoundException') {
        checks.add(
          name,
          'info',
          'no resource policy — fine for same-account pulls (job roles pull via SERVICE_ROLE ' +
            'credentials); cross-account pulls need one',
        );
      } else {
        checks.add(name, 'warn', `not readable (${(err as Error).message}) — best-effort check skipped`);
      }
    }
  }
}

async function checkRulesets(
  checks: Checks,
  deps: DoctorDeps,
  auth: GithubAuth | undefined,
  repo: WatchedRepo,
): Promise<void> {
  if (repo.config.secretsAllowedRefs.length === 0) {
    return;
  }
  const name = `rulesets ${repo.repo}`;
  const patterns = repo.config.secretsAllowedRefs.join(', ');
  const token = auth ? await auth.repoToken(repo.repo) : undefined;
  if (token === undefined) {
    checks.add(name, 'info', `rulesets not readable — cannot verify protection of ${patterns}`);
    return;
  }
  try {
    const rulesets = await listRepoRulesets(deps.fetchLike, token, repo.repo);
    const active = rulesets.filter((r) => r.enforcement === 'active' && r.target === 'branch');
    if (active.length === 0) {
      checks.add(
        name,
        'warn',
        `secretsAllowedRefs (${patterns}) have no active branch ruleset — anyone who can push ` +
          'those refs gets secrets; protect them with a ruleset',
      );
      return;
    }
    checks.add(
      name,
      'ok',
      `${active.length} active branch ruleset${active.length === 1 ? '' : 's'} cover the repo ` +
        `(secretsAllowedRefs: ${patterns})`,
    );
  } catch (err) {
    checks.add(name, 'info', `rulesets not readable (${(err as Error).message})`);
  }
}

export async function doctor(deps: DoctorDeps, options: DiscoverOptions = {}): Promise<DoctorReport> {
  const deployment = await discoverDeployment(deps.ssm, options);
  const checks = new Checks(deps.output);

  checkManifest(checks, deployment);

  const repos = await listWatchedRepos(deps.ssm, deployment);
  let auth: GithubAuth | undefined;
  await checks.run('github-credentials', async () => {
    auth = await checkGithubCredentials(checks, deps, deployment);
  });

  const rawPins = await getOptionalParameter(deps.ssm, hostKeysParameterName(deployment.name));
  const hostKeyPins = rawPins === undefined ? [] : parseHostKeyPins(rawPins);
  if (rawPins === undefined) {
    checks.add(
      'host-keys',
      'warn',
      `no pinned host keys at ${hostKeysParameterName(deployment.name)} — run "millwright setup" ` +
        'or "millwright refresh-host-keys"',
    );
  } else {
    checks.add('host-keys', 'ok', `${hostKeyPins.length} GitHub host keys pinned`);
  }

  if (repos.length === 0) {
    checks.add('repos', 'info', 'no repos configured — "millwright repo add <owner/repo>" to watch one');
  }

  const heads = new Map<string, DefaultBranchHead | undefined>();
  for (const repo of repos) {
    if (auth) {
      await checks.run(`pulls-probe ${repo.repo}`, () => checkPullsProbe(checks, deps, auth!, repo));
    }
    await checks.run(`deploy-key ${repo.repo}`, async () => {
      heads.set(repo.repo, await checkDeployKey(checks, deps, deployment, repo, hostKeyPins));
    });
  }

  await checks.run('poller', () => checkPoller(checks, deps, deployment, repos.length));

  for (const repo of repos) {
    await checks.run(`registry ${repo.repo}`, () =>
      checkRegistry(checks, deps, deployment, repo, heads.get(repo.repo)),
    );
  }

  await checks.run('quotas', () => checkQuotas(checks, deps, deployment));
  await checks.run('ecr', () => checkEcrPolicies(checks, deps, repos));
  for (const repo of repos) {
    await checks.run(`rulesets ${repo.repo}`, () => checkRulesets(checks, deps, auth, repo));
  }

  const failed = checks.failed;
  deps.output(
    failed === 0
      ? `doctor: all checks passed (${checks.checks.length} checks)`
      : `doctor: ${failed} check${failed === 1 ? '' : 's'} FAILED`,
  );
  return { checks: checks.checks, failed };
}
