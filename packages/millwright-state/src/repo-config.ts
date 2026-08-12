/**
 * The polling-relevant slice of the repo config parameter's JSON payload
 * (spec §9.2): written by `repo add`/`repo update` under operator IAM, read
 * by the poller (the tier-2 `prPolling` gate) and the launcher (fork-PR
 * enforcement, spec §13.1a). Parsing is deliberately tolerant — a partial or
 * unreadable document degrades to the defaults instead of wedging polling on
 * a bad write, and unrelated fields (`secretsAllowedRefs`, `ecrPullRepos`)
 * pass through untouched.
 */

export interface RepoPollingConfig {
  /** Tier-2 PR polling for this repo (spec §6.2). Default on. */
  readonly prPolling: boolean;
  /**
   * Runs for fork-authored PRs (spec §13.1a). Default OFF: even secret-less,
   * fork code executes in the synth job, which holds the repo's deploy key.
   */
  readonly forkPrPolicy: boolean;
}

export const DEFAULT_REPO_POLLING_CONFIG: RepoPollingConfig = {
  prPolling: true,
  forkPrPolicy: false,
};

/** Booleans and the CLI's `on`/`off` strings; anything else keeps the default. */
function toggle(value: unknown, fallback: boolean): boolean {
  if (typeof value === 'boolean') {
    return value;
  }
  return value === 'on' ? true : value === 'off' ? false : fallback;
}

export function parseRepoPollingConfig(json: string | undefined): RepoPollingConfig {
  if (!json) {
    return DEFAULT_REPO_POLLING_CONFIG;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    return DEFAULT_REPO_POLLING_CONFIG;
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    return DEFAULT_REPO_POLLING_CONFIG;
  }
  const doc = parsed as Record<string, unknown>;
  return {
    prPolling: toggle(doc.prPolling, DEFAULT_REPO_POLLING_CONFIG.prPolling),
    forkPrPolicy: toggle(doc.forkPrPolicy, DEFAULT_REPO_POLLING_CONFIG.forkPrPolicy),
  };
}
