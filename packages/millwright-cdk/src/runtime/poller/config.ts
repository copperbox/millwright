import {
  DEFAULT_REPO_POLLING_CONFIG,
  RepoPollingConfig,
  configPlaneRoot,
  deployKeyParameterName,
  githubAppParameterName,
  hostKeysParameterName,
  parseRepoPollingConfig,
} from '@copperbox/millwright-state';
import type {
  GetParameterCommandOutput,
  GetParametersByPathCommandOutput,
  GetParametersCommandOutput,
} from '@aws-sdk/client-ssm';
import {
  GetParameterCommand,
  GetParametersByPathCommand,
  GetParametersCommand,
  ParameterNotFound,
} from '@aws-sdk/client-ssm';
import { ConfigPlane } from './poller';
import { PrConfigPlane } from './pr-poll';

/** The SSM client slice the poller uses; tests inject a fake. */
export interface SsmClientLike {
  send(command: GetParametersByPathCommand): Promise<GetParametersByPathCommandOutput>;
  send(command: GetParametersCommand): Promise<GetParametersCommandOutput>;
  send(command: GetParameterCommand): Promise<GetParameterCommandOutput>;
}

/** GetParameters accepts at most ten names per call. */
const GET_PARAMETERS_BATCH = 10;

/**
 * The poller's config-plane reads (spec §6.1, §9.2): repo discovery by
 * listing the `repos/` subtree, deploy keys batch-fetched via `GetParameters`
 * and cached in memory while the Lambda is warm, host-key pins re-read each
 * tick (one parameter — staleness is not worth the machinery). The listing
 * already carries each repo's config document, so the tier-2 toggles
 * (`prPolling`, `forkPrPolicy`) cost no extra calls.
 */
export class SsmConfigPlane implements ConfigPlane, PrConfigPlane {
  private readonly deployKeys = new Map<string, string>();
  private repoConfigs = new Map<string, RepoPollingConfig>();
  private readonly reposPath: string;

  constructor(
    private readonly client: SsmClientLike,
    private readonly deploymentName: string,
  ) {
    this.reposPath = `${configPlaneRoot(deploymentName)}/repos`;
  }

  /**
   * Every repo with a config parameter, from a recursive non-decrypting
   * listing (deploy-key SecureStrings under the same subtree come back as
   * ciphertext and are ignored here). Refreshed each tick, so `repo add`
   * takes effect within one cadence without a poller redeploy.
   */
  async listRepos(): Promise<string[]> {
    const repos: string[] = [];
    const configs = new Map<string, RepoPollingConfig>();
    let nextToken: string | undefined;
    do {
      const page = await this.client.send(
        new GetParametersByPathCommand({
          Path: this.reposPath,
          Recursive: true,
          NextToken: nextToken,
        }),
      );
      for (const parameter of page.Parameters ?? []) {
        const repo = repoFromParameter(this.reposPath, parameter.Name, 'config');
        if (repo) {
          repos.push(repo);
          configs.set(repo, parseRepoPollingConfig(parameter.Value));
        }
      }
      nextToken = page.NextToken;
    } while (nextToken);
    this.repoConfigs = configs;
    return repos.sort();
  }

  /**
   * Polling toggles captured by the same tick's `listRepos` listing, so
   * `repo update --fork-prs on` takes effect within one cadence. A repo the
   * listing has not (re)seen answers with the defaults.
   */
  getRepoConfig(repo: string): RepoPollingConfig {
    return this.repoConfigs.get(repo) ?? DEFAULT_REPO_POLLING_CONFIG;
  }

  /**
   * Deploy keys for the given repos: batch `GetParameters` with decryption
   * for cache misses only — a warm tick over a stable repo set fetches
   * nothing (spec §6.1 key handling). A repo whose key parameter is missing
   * is simply absent from the answer; the tick quarantines it.
   */
  async getDeployKeys(repos: readonly string[]): Promise<Map<string, string>> {
    const missing = repos.filter((repo) => !this.deployKeys.has(repo));
    for (let start = 0; start < missing.length; start += GET_PARAMETERS_BATCH) {
      const batch = missing.slice(start, start + GET_PARAMETERS_BATCH);
      const result = await this.client.send(
        new GetParametersCommand({
          Names: batch.map((repo) => deployKeyParameterName(this.deploymentName, repo)),
          WithDecryption: true,
        }),
      );
      for (const parameter of result.Parameters ?? []) {
        const repo = repoFromParameter(this.reposPath, parameter.Name, 'deploy-key');
        if (repo && parameter.Value) {
          this.deployKeys.set(repo, parameter.Value);
        }
      }
    }
    const keys = new Map<string, string>();
    for (const repo of repos) {
      const key = this.deployKeys.get(repo);
      if (key) {
        keys.set(repo, key);
      }
    }
    return keys;
  }

  /** A rejected key is evicted so quarantine retries re-fetch a rotated one. */
  evictDeployKey(repo: string): void {
    this.deployKeys.delete(repo);
  }

  async getHostKeysParameter(): Promise<string | undefined> {
    return this.readParameter(
      new GetParameterCommand({ Name: hostKeysParameterName(this.deploymentName) }),
    );
  }

  /**
   * The `github/app` SecureString (spec §9.2) — the tier-2 token minter's
   * credential source. Absent until `millwright setup` completes; tier 2
   * stays idle without it.
   */
  async getGithubAppParameter(): Promise<string | undefined> {
    return this.readParameter(
      new GetParameterCommand({
        Name: githubAppParameterName(this.deploymentName),
        WithDecryption: true,
      }),
    );
  }

  private async readParameter(command: GetParameterCommand): Promise<string | undefined> {
    try {
      const result = await this.client.send(command);
      return result.Parameter?.Value;
    } catch (err) {
      if (err instanceof ParameterNotFound) {
        return undefined;
      }
      throw err;
    }
  }
}

/** `<reposPath>/<owner>/<repo>/<leaf>` → `owner/repo`, else undefined. */
function repoFromParameter(
  reposPath: string,
  name: string | undefined,
  leaf: 'config' | 'deploy-key',
): string | undefined {
  const suffix = `/${leaf}`;
  if (!name?.startsWith(`${reposPath}/`) || !name.endsWith(suffix)) {
    return undefined;
  }
  const repo = name.slice(reposPath.length + 1, -suffix.length);
  return /^[^/]+\/[^/]+$/.test(repo) ? repo : undefined;
}
