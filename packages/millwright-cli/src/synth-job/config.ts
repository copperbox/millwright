/**
 * The synth job's environment contract (spec §7.2). The synth Lambda starts
 * the CodeBuild build with exactly these variables: identity and destination
 * as plaintext, the deploy key / host-key pins / repo config resolved by
 * CodeBuild's `PARAMETER_STORE` env type under the synth job role — the key
 * material never rides the StartBuild call.
 */

export const MODEL_OBJECT = 'model.json';
export const SOURCE_OBJECT = 'source.tar.gz';

/**
 * Written to the same `in/` prefix when synth fails, so the control plane
 * (synth-events completer, check reporting) can surface the actual error
 * instead of "see the build log". Never read as anything but display text —
 * it is authored next to repo-controlled code.
 */
export const SYNTH_ERROR_OBJECT = 'synth-error.json';

export class SynthJobConfigError extends Error {}

export interface SynthJobConfig {
  /** `owner/name` of the watched repo. */
  readonly repo: string;
  /** Commit the run triggered at — what gets checked out and synthesized. */
  readonly sha: string;
  /** Full triggering ref (`refs/heads/main`, `refs/pull/17/head`). */
  readonly ref: string;
  readonly destBucket: string;
  /** The run's `in/` prefix — the only S3 the synth job role may write. */
  readonly destPrefix: string;
  /** The control plane's supported run-model schemaVersion. */
  readonly schemaCeiling: number;
  /** Deploy key material (parameter-store resolved). */
  readonly deployKey: string;
  /** known_hosts content pinned from the same SSM parameter the poller uses. */
  readonly hostKeys: string;
  /** Poll cadence for the cron-granularity lint. */
  readonly pollCadenceMinutes?: number;
  /** `secretsAllowedRefs` from the repo config — fail-fast lint input only. */
  readonly secretsAllowedRefs?: readonly string[];
}

const REQUIRED = [
  'MILLWRIGHT_REPO',
  'MILLWRIGHT_SHA',
  'MILLWRIGHT_REF',
  'MILLWRIGHT_DEST_BUCKET',
  'MILLWRIGHT_DEST_PREFIX',
  'MILLWRIGHT_SCHEMA_CEILING',
  'MILLWRIGHT_DEPLOY_KEY',
  'MILLWRIGHT_HOST_KEYS',
] as const;

export function configFromEnv(
  env: Readonly<Record<string, string | undefined>>,
): SynthJobConfig {
  const missing = REQUIRED.filter((name) => !env[name]);
  if (missing.length > 0) {
    throw new SynthJobConfigError(
      `Synth job environment is incomplete; missing ${missing.join(', ')}`,
    );
  }
  const schemaCeiling = Number(env.MILLWRIGHT_SCHEMA_CEILING);
  if (!Number.isInteger(schemaCeiling) || schemaCeiling <= 0) {
    throw new SynthJobConfigError(
      `MILLWRIGHT_SCHEMA_CEILING must be a positive integer, got "${env.MILLWRIGHT_SCHEMA_CEILING}"`,
    );
  }
  const pollCadence = env.MILLWRIGHT_POLL_CADENCE_MINUTES
    ? Number(env.MILLWRIGHT_POLL_CADENCE_MINUTES)
    : undefined;

  return {
    repo: env.MILLWRIGHT_REPO!,
    sha: env.MILLWRIGHT_SHA!,
    ref: env.MILLWRIGHT_REF!,
    destBucket: env.MILLWRIGHT_DEST_BUCKET!,
    destPrefix: env.MILLWRIGHT_DEST_PREFIX!,
    schemaCeiling,
    deployKey: env.MILLWRIGHT_DEPLOY_KEY!,
    hostKeys: env.MILLWRIGHT_HOST_KEYS!,
    ...(pollCadence !== undefined && Number.isFinite(pollCadence) && pollCadence > 0
      ? { pollCadenceMinutes: pollCadence }
      : {}),
    ...secretsAllowedRefsFrom(env.MILLWRIGHT_REPO_CONFIG),
  };
}

/**
 * The repo config feeds lints only (enforcement is the decider's, at
 * dispatch), so a malformed document degrades to "no lint input" rather than
 * failing the synth.
 */
function secretsAllowedRefsFrom(
  json: string | undefined,
): { secretsAllowedRefs?: readonly string[] } {
  if (!json) {
    return {};
  }
  try {
    const parsed: unknown = JSON.parse(json);
    const refs = (parsed as { secretsAllowedRefs?: unknown })?.secretsAllowedRefs;
    if (Array.isArray(refs) && refs.every((r) => typeof r === 'string')) {
      return { secretsAllowedRefs: refs };
    }
  } catch {
    // fall through
  }
  return {};
}

/**
 * Short name for branch and tag refs; anything else (notably `refs/pull/N/…`
 * run identities) stays a full ref — which is exactly what keeps PR runs
 * structurally unmatchable by `secretsAllowedRefs` (spec §12a).
 */
export function shortRefName(ref: string): string {
  const match = ref.match(/^refs\/(?:heads|tags)\/(.+)$/);
  return match ? match[1] : ref;
}

/** PR number of a `refs/pull/N/…` ref, undefined for every other shape. */
export function prNumberFromRef(ref: string): number | undefined {
  const match = ref.match(/^refs\/pull\/(\d+)\//);
  return match ? Number(match[1]) : undefined;
}
