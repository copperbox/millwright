/**
 * `millwright repo add / update / list / remove` (spec §3.3, §13.1, §15):
 * repo onboarding writes the config parameter, mints and installs a per-repo
 * read-only Ed25519 deploy key, verifies it with an ls-refs exchange that
 * also resolves the default-branch head, and emits the `bootstrap` event
 * (`source: millwright.cli`) that primes the per-ref registry and yields a
 * visible synth check.
 */

import { PutEventsCommand } from '@aws-sdk/client-eventbridge';
import {
  GithubCredentials,
  RepoConfig,
  configPlaneRoot,
  defaultRepoConfig,
  deployKeyParameterName,
  githubAppParameterName,
  hostKeysParameterName,
  parseGithubCredentials,
  parseRepoConfig,
  repoConfigParameterName,
  repoFromConfigParameterName,
  serializeRepoConfig,
} from '@copperbox/millwright-state';
import {
  CommandError,
  configKeyId,
  deleteParameters,
  eventBusName,
  getOptionalParameter,
  listParametersByPrefix,
  putSecureStringParameter,
  putStringParameter,
} from './config-plane';
import { Deployment, DiscoverOptions, SsmClientLike, discoverDeployment } from './discovery';
import { DefaultBranchHead, lsRefs, resolveDefaultBranchHead } from './git/ls-refs';
import { parseHostKeyPins, withUploadPack } from './git/ssh';
import { signAppJwt } from './github/app-auth';
import { DeployKeyPair, generateDeployKey } from './github/deploy-key';
import {
  FetchLike,
  GithubApiError,
  createDeployKey,
  createInstallationToken,
  deleteDeployKey,
  getRepoInstallationId,
  listDeployKeys,
} from './github/rest';

const REPO_PATTERN = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;

/** The slice of EventBridgeClient the CLI uses; tests inject a fake. */
export interface EventBridgeClientLike {
  send(command: unknown): Promise<any>;
}

export interface ResolveHeadOptions {
  readonly repo: string;
  readonly privateKey: string;
  readonly hostKeyPins: readonly Buffer[];
}

export interface RepoDeps {
  readonly ssm: SsmClientLike;
  readonly fetchLike: FetchLike;
  readonly eventBridge: EventBridgeClientLike;
  readonly output: (line: string) => void;
  /** Blocks until the operator confirms a manual step (deploy-key add). */
  readonly waitForOperator: (message: string) => Promise<void>;
  /** Injectable for tests. @default generateDeployKey */
  readonly generateKey?: (comment: string) => DeployKeyPair;
  /** Injectable for tests. @default a real SSH ls-refs exchange */
  readonly resolveHead?: (options: ResolveHeadOptions) => Promise<DefaultBranchHead>;
  readonly now?: () => Date;
  readonly sleep?: (ms: number) => Promise<void>;
}

export interface RepoFlagOptions {
  /** `--secrets-refs` — ref-name patterns whose runs receive secrets. */
  readonly secretsRefs?: readonly string[];
  /** `--no-pr-polling` / `--pr-polling` — tier-2 PR polling toggle. */
  readonly prPolling?: boolean;
  /** `--fork-prs` — run fork-authored PRs (default off, spec §13.1a). */
  readonly forkPrs?: 'on' | 'off';
  /** `--ecr-repos` — private-ECR pull allowlist ARNs. */
  readonly ecrRepos?: readonly string[];
}

export interface RepoAddOptions extends DiscoverOptions, RepoFlagOptions {
  readonly repo: string;
}

function assertRepoName(repo: string): void {
  if (!REPO_PATTERN.test(repo)) {
    throw new CommandError(`"${repo}" is not an owner/repo name`);
  }
}

function deployKeyTitle(deployment: Deployment): string {
  return `millwright/${deployment.name}`;
}

async function loadCredentials(
  ssm: SsmClientLike,
  deployment: Deployment,
): Promise<GithubCredentials> {
  const raw = await getOptionalParameter(ssm, githubAppParameterName(deployment.name), {
    decrypt: true,
  });
  if (raw === undefined) {
    throw new CommandError(
      `no GitHub credentials at ${githubAppParameterName(deployment.name)} — run "millwright setup" first`,
    );
  }
  return parseGithubCredentials(raw);
}

async function loadHostKeyPins(ssm: SsmClientLike, deployment: Deployment): Promise<Buffer[]> {
  const raw = await getOptionalParameter(ssm, hostKeysParameterName(deployment.name));
  const pins = raw === undefined ? [] : parseHostKeyPins(raw);
  if (pins.length === 0) {
    throw new CommandError(
      `no pinned host keys at ${hostKeysParameterName(deployment.name)} — run "millwright setup" first`,
    );
  }
  return pins;
}

/**
 * A repo-scoped API token: an installation token in App mode (minted on
 * demand, held in memory only — spec §13.1), the PAT itself in PAT mode.
 */
async function mintRepoToken(
  deps: RepoDeps,
  credentials: GithubCredentials,
  repo: string,
): Promise<string | undefined> {
  if (credentials.mode === 'pat') {
    return credentials.token;
  }
  const nowSeconds = Math.floor((deps.now?.() ?? new Date()).getTime() / 1000);
  const appJwt = signAppJwt(credentials.appId, credentials.privateKeyPem, nowSeconds);
  const installationId = await getRepoInstallationId(deps.fetchLike, appJwt, repo);
  if (installationId === undefined) {
    return undefined;
  }
  return (await createInstallationToken(deps.fetchLike, appJwt, installationId)).token;
}

/** Install the key via the API when possible, else hand it to the operator. */
async function installDeployKey(
  deps: RepoDeps,
  deployment: Deployment,
  credentials: GithubCredentials,
  repo: string,
  publicKey: string,
): Promise<void> {
  const token = await mintRepoToken(deps, credentials, repo);
  if (token !== undefined) {
    try {
      await createDeployKey(deps.fetchLike, token, repo, {
        title: deployKeyTitle(deployment),
        key: publicKey,
      });
      deps.output(`Installed read-only deploy key "${deployKeyTitle(deployment)}" on ${repo}.`);
      return;
    } catch (err) {
      if (!(err instanceof GithubApiError) || (err.status !== 403 && err.status !== 404)) {
        throw err;
      }
      deps.output(`GitHub refused the deploy-key install (${err.status}); falling back to manual add.`);
    }
  } else {
    deps.output(
      `The GitHub App is not installed on ${repo} — install it (github.com/apps/` +
        `${credentials.mode === 'app' ? credentials.slug : ''}/installations/new) to automate this, ` +
        'or add the key manually.',
    );
  }
  deps.output(`Add this read-only deploy key to https://github.com/${repo}/settings/keys :`);
  deps.output(`  ${publicKey}`);
  await deps.waitForOperator('Press Enter once the deploy key is added…');
}

/** ls-refs with the fresh key: the install-time key check (spec §13.1). */
async function verifyKeyAndResolveHead(
  deps: RepoDeps,
  repo: string,
  privateKey: string,
  hostKeyPins: readonly Buffer[],
): Promise<DefaultBranchHead> {
  const resolveHead =
    deps.resolveHead ??
    (async (options: ResolveHeadOptions) =>
      resolveDefaultBranchHead(
        await withUploadPack(options, (stream) => lsRefs(stream, { refPrefixes: ['HEAD'] })),
      ));
  const sleep = deps.sleep ?? ((ms: number) => new Promise((r) => setTimeout(r, ms)));
  const attempts = 3;
  let lastError: unknown;
  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      return await resolveHead({ repo, privateKey, hostKeyPins });
    } catch (err) {
      lastError = err;
      if (attempt < attempts) {
        deps.output(`Key check attempt ${attempt} failed (${(err as Error).message}); retrying…`);
        await sleep(3_000);
      }
    }
  }
  throw new CommandError(
    `the fresh deploy key could not read ${repo} after ${attempts} attempts ` +
      `(${(lastError as Error).message}) — is the key installed on the right repo?`,
  );
}

async function emitBootstrapEvent(
  deps: RepoDeps,
  deployment: Deployment,
  repo: string,
  ref: string,
  sha: string,
): Promise<void> {
  const bus = eventBusName(deployment);
  if (!bus) {
    deps.output(
      'The deployment manifest names no event bus yet — skipping the bootstrap event; ' +
        'the poller will prime the registry on its first tick instead.',
    );
    return;
  }
  const result = await deps.eventBridge.send(
    new PutEventsCommand({
      Entries: [
        {
          EventBusName: bus,
          Source: 'millwright.cli',
          DetailType: 'bootstrap',
          Detail: JSON.stringify({ repo, ref, sha, kind: 'bootstrap' }),
        },
      ],
    }),
  );
  if (result?.FailedEntryCount) {
    throw new CommandError(
      `the bootstrap event was not accepted by bus "${bus}" — check the operator role's events:PutEvents grant`,
    );
  }
  deps.output(`Emitted bootstrap event for ${repo}@${sha.slice(0, 12)} (${ref}).`);
}

function mergeConfig(base: RepoConfig, flags: RepoFlagOptions): RepoConfig {
  return {
    secretsAllowedRefs: flags.secretsRefs ?? base.secretsAllowedRefs,
    prPolling: flags.prPolling ?? base.prPolling,
    forkPrPolicy: flags.forkPrs ?? base.forkPrPolicy,
    ecrPullRepos: flags.ecrRepos ?? base.ecrPullRepos,
  };
}

function describeConfig(config: RepoConfig): string[] {
  return [
    `  secretsAllowedRefs: ${config.secretsAllowedRefs.length ? config.secretsAllowedRefs.join(', ') : '(none — no ref receives secrets)'}`,
    `  prPolling: ${config.prPolling}`,
    `  forkPrPolicy: ${config.forkPrPolicy}`,
    `  ecrPullRepos: ${config.ecrPullRepos.length ? config.ecrPullRepos.join(', ') : '(none)'}`,
  ];
}

export async function repoAdd(deps: RepoDeps, options: RepoAddOptions): Promise<void> {
  assertRepoName(options.repo);
  const deployment = await discoverDeployment(deps.ssm, options);
  const keyId = configKeyId(deployment);
  const configParameter = repoConfigParameterName(deployment.name, options.repo);
  const keyParameter = deployKeyParameterName(deployment.name, options.repo);

  if ((await getOptionalParameter(deps.ssm, configParameter)) !== undefined) {
    throw new CommandError(
      `${options.repo} is already configured (${configParameter}) — use "millwright repo update"`,
    );
  }
  const credentials = await loadCredentials(deps.ssm, deployment);
  const hostKeyPins = await loadHostKeyPins(deps.ssm, deployment);

  const generate = deps.generateKey ?? generateDeployKey;
  const keyPair = generate(`${deployKeyTitle(deployment)} ${options.repo}`);
  await installDeployKey(deps, deployment, credentials, options.repo, keyPair.publicKey);

  // Key parameter before config parameter: the poller discovers repos by
  // config prefix, and must never find a repo whose key is missing.
  await putSecureStringParameter(
    deps.ssm,
    keyParameter,
    keyPair.privateKey,
    keyId,
    `millwright read-only deploy key for ${options.repo}`,
  );

  const head = await verifyKeyAndResolveHead(deps, options.repo, keyPair.privateKey, hostKeyPins);
  deps.output(`Deploy key verified: ls-refs read ${options.repo} over SSH.`);

  const config = mergeConfig(defaultRepoConfig(), options);
  await putStringParameter(
    deps.ssm,
    configParameter,
    serializeRepoConfig(config),
    `millwright repo config for ${options.repo}`,
  );
  deps.output(`Wrote ${configParameter}:`);
  for (const line of describeConfig(config)) {
    deps.output(line);
  }

  if (head.empty || !head.sha) {
    deps.output(
      `${options.repo} is empty${head.branch ? ` (default branch ${head.branch} is unborn)` : ''} — ` +
        'triggers activate on the first push.',
    );
    return;
  }
  if (!head.ref) {
    deps.output(
      `${options.repo} reported no default-branch symref — skipping the bootstrap event; ` +
        'the poller will prime the registry on its first tick.',
    );
    return;
  }
  await emitBootstrapEvent(deps, deployment, options.repo, head.ref, head.sha);
  deps.output(
    `Onboarding complete — expect a "millwright / synth" check on ${head.branch ?? head.ref} @ ` +
      `${head.sha.slice(0, 12)} once the control plane processes the bootstrap.`,
  );
}

export interface RepoUpdateOptions extends DiscoverOptions, RepoFlagOptions {
  readonly repo: string;
}

export async function repoUpdate(deps: RepoDeps, options: RepoUpdateOptions): Promise<void> {
  assertRepoName(options.repo);
  const deployment = await discoverDeployment(deps.ssm, options);
  const configParameter = repoConfigParameterName(deployment.name, options.repo);
  const raw = await getOptionalParameter(deps.ssm, configParameter);
  if (raw === undefined) {
    throw new CommandError(`${options.repo} is not configured — use "millwright repo add" first`);
  }
  const config = mergeConfig(parseRepoConfig(raw), options);
  await putStringParameter(
    deps.ssm,
    configParameter,
    serializeRepoConfig(config),
    `millwright repo config for ${options.repo}`,
  );
  deps.output(`Updated ${configParameter}:`);
  for (const line of describeConfig(config)) {
    deps.output(line);
  }
}

export interface RepoListEntry {
  readonly repo: string;
  readonly config: RepoConfig;
}

export async function repoList(
  deps: RepoDeps,
  options: DiscoverOptions = {},
): Promise<RepoListEntry[]> {
  const deployment = await discoverDeployment(deps.ssm, options);
  const prefix = `${configPlaneRoot(deployment.name)}/repos/`;
  const entries: RepoListEntry[] = [];
  for (const parameter of await listParametersByPrefix(deps.ssm, prefix)) {
    const repo = repoFromConfigParameterName(deployment.name, parameter.name);
    if (repo) {
      entries.push({ repo, config: parseRepoConfig(parameter.value) });
    }
  }
  entries.sort((a, b) => a.repo.localeCompare(b.repo));
  if (entries.length === 0) {
    deps.output(`No repos configured for deployment "${deployment.name}".`);
    return entries;
  }
  for (const entry of entries) {
    deps.output(
      `${entry.repo}  prPolling=${entry.config.prPolling} forkPrPolicy=${entry.config.forkPrPolicy} ` +
        `secretsRefs=${entry.config.secretsAllowedRefs.join(',') || '-'} ` +
        `ecrRepos=${entry.config.ecrPullRepos.length || '-'}`,
    );
  }
  return entries;
}

export interface RepoRemoveOptions extends DiscoverOptions {
  readonly repo: string;
}

export async function repoRemove(deps: RepoDeps, options: RepoRemoveOptions): Promise<void> {
  assertRepoName(options.repo);
  const deployment = await discoverDeployment(deps.ssm, options);
  const configParameter = repoConfigParameterName(deployment.name, options.repo);
  const keyParameter = deployKeyParameterName(deployment.name, options.repo);

  // Best-effort GitHub-side cleanup: delete the deploy key we installed
  // (matched by title). Config-plane removal is the operation that counts.
  try {
    const raw = await getOptionalParameter(deps.ssm, githubAppParameterName(deployment.name), {
      decrypt: true,
    });
    const token =
      raw === undefined
        ? undefined
        : await mintRepoToken(deps, parseGithubCredentials(raw), options.repo);
    if (token !== undefined) {
      const keys = await listDeployKeys(deps.fetchLike, token, options.repo);
      const ours = keys.find((key) => key.title === deployKeyTitle(deployment));
      if (ours) {
        await deleteDeployKey(deps.fetchLike, token, options.repo, ours.id);
        deps.output(`Removed deploy key "${ours.title}" from ${options.repo}.`);
      }
    }
  } catch (err) {
    deps.output(
      `Could not remove the GitHub deploy key (${(err as Error).message}) — ` +
        `delete "${deployKeyTitle(deployment)}" at https://github.com/${options.repo}/settings/keys`,
    );
  }

  const deleted = await deleteParameters(deps.ssm, [configParameter, keyParameter]);
  if (deleted.length === 0) {
    throw new CommandError(`${options.repo} is not configured for deployment "${deployment.name}"`);
  }
  deps.output(`Deleted ${deleted.sort().join(', ')}.`);
}
