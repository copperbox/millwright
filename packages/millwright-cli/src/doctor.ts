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
  githubAppParameterName,
  hostKeysParameterName,
  parseGithubCredentials,
  parseRepoConfig,
  refMapKey,
  repoFromConfigParameterName,
  CIRCUIT_BREAKER_KEY,
} from '@copperbox/millwright-state';
import { GetRepositoryPolicyCommand } from '@aws-sdk/client-ecr';
import { GetAccountSummaryCommand, ListRolesCommand } from '@aws-sdk/client-iam';
import { ListServiceQuotasCommand } from '@aws-sdk/client-service-quotas';
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

/** The slice of the IAM / Service Quotas / ECR clients doctor uses. */
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

/**
 * The §8.3 gate: a configured repo with polling activity but no
 * default-branch registry entry is a hard FAIL naming the bootstrap remedy.
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
    checks.add(
      name,
      'fail',
      `${repo.repo} is being polled but has no default-branch registry entry — its pushes ` +
        `cannot match any workflow. Re-run "millwright repo add ${repo.repo}" to emit the ` +
        `bootstrap event (or push to ${head?.branch ?? defaultRef}) so the registry gets primed`,
    );
    return;
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
