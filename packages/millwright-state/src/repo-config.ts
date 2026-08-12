/**
 * The per-repo config parameter, `/millwright/<name>/repos/<repo>/config`
 * (spec §3.3, §9.2). Written by `millwright repo add/update` under operator
 * IAM; read by the poller (by path prefix) and the decider. Stored as plain
 * JSON in a String parameter — nothing here is secret, and gating writes on
 * operator IAM is the point of the config split.
 */

export type ForkPrPolicy = 'on' | 'off';

export interface RepoConfig {
  /**
   * Ref-name patterns whose runs may receive secrets (spec §12a): short ref
   * names, anchored, `*` the only metacharacter. Empty means no ref receives
   * secrets — the shortest onboarding command is the safe one.
   */
  readonly secretsAllowedRefs: readonly string[];
  /** Tier-2 PR polling toggle (spec §6.2). */
  readonly prPolling: boolean;
  /** Fork-authored PRs run only when the operator opts in (spec §13.1a). */
  readonly forkPrPolicy: ForkPrPolicy;
  /** Private-ECR pull allowlist granted to this repo's job roles (spec §10.2). */
  readonly ecrPullRepos: readonly string[];
}

export class RepoConfigFormatError extends Error {}

export function defaultRepoConfig(): RepoConfig {
  return {
    secretsAllowedRefs: [],
    prPolling: true,
    forkPrPolicy: 'off',
    ecrPullRepos: [],
  };
}

function stringArray(label: string, value: unknown, fallback: readonly string[]): string[] {
  if (value === undefined) {
    return [...fallback];
  }
  if (!Array.isArray(value) || value.some((entry) => typeof entry !== 'string')) {
    throw new RepoConfigFormatError(`${label} must be an array of strings`);
  }
  return value as string[];
}

/** Parse a stored config value, filling spec defaults for absent fields. */
export function parseRepoConfig(raw: string): RepoConfig {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    throw new RepoConfigFormatError('repo config is not valid JSON');
  }
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new RepoConfigFormatError('repo config must be a JSON object');
  }
  const record = value as Record<string, unknown>;
  const defaults = defaultRepoConfig();
  if (record.prPolling !== undefined && typeof record.prPolling !== 'boolean') {
    throw new RepoConfigFormatError('prPolling must be a boolean');
  }
  if (
    record.forkPrPolicy !== undefined &&
    record.forkPrPolicy !== 'on' &&
    record.forkPrPolicy !== 'off'
  ) {
    throw new RepoConfigFormatError('forkPrPolicy must be "on" or "off"');
  }
  return {
    secretsAllowedRefs: stringArray(
      'secretsAllowedRefs',
      record.secretsAllowedRefs,
      defaults.secretsAllowedRefs,
    ),
    prPolling: (record.prPolling as boolean | undefined) ?? defaults.prPolling,
    forkPrPolicy: (record.forkPrPolicy as ForkPrPolicy | undefined) ?? defaults.forkPrPolicy,
    ecrPullRepos: stringArray('ecrPullRepos', record.ecrPullRepos, defaults.ecrPullRepos),
  };
}

/** Serialize with a stable key order so unchanged configs diff clean. */
export function serializeRepoConfig(config: RepoConfig): string {
  return JSON.stringify(
    {
      secretsAllowedRefs: config.secretsAllowedRefs,
      prPolling: config.prPolling,
      forkPrPolicy: config.forkPrPolicy,
      ecrPullRepos: config.ecrPullRepos,
    },
    null,
    2,
  );
}
