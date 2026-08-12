import { shortRefName } from './bus-events';
import { RunModelJob } from './run-model';

/**
 * The `secretsAllowedRefs` matcher and gate (spec §12a, §10.2) — the
 * control-plane copy the decider enforces with at dispatch. The workflows
 * package carries the same dialect for its fail-fast synth lint; that check
 * runs inside repo-controlled code and is UX only, never enforcement.
 *
 * Dialect: patterns match the SHORT ref name as pushed (`main`,
 * `release/1.2`, tag names likewise), anchored at both ends; `*` is the only
 * metacharacter and crosses `/`; no implicit prefix or substring behavior —
 * `main` matches exactly `main`, never `mainline`. A run identity that is
 * still a full ref (a PR run's `refs/pull/N`) never short-name-matches, so
 * "no secrets on PR runs" is structural, not emergent.
 *
 * HONEST LIMIT, stated loudly: an allowlisted ref NAME is only as strong as
 * the GitHub-side protection of that namespace. `secretsAllowedRefs:
 * ["release/*"]` hands secrets to anyone who can push `release/anything`
 * unless a ruleset protects that namespace. `doctor` warns where it can read
 * ruleset state; otherwise the documentation warning is the control.
 */

const escapeRegExp = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

export function matchesRefPattern(shortRef: string, pattern: string): boolean {
  if (shortRef.startsWith('refs/')) {
    return false;
  }
  const regex = new RegExp(`^${pattern.split('*').map(escapeRegExp).join('.*')}$`);
  return regex.test(shortRef);
}

/** True when any pattern matches. An empty or absent allowlist matches no ref. */
export function matchesAnyRefPattern(
  shortRef: string,
  patterns: readonly string[] | undefined,
): boolean {
  return (patterns ?? []).some((pattern) => matchesRefPattern(shortRef, pattern));
}

/**
 * The two stable job-role variants (spec §10.2). The no-secret variant
 * contains nothing model-derived; the full variant adds exactly the declared
 * secret grants and exists only for `secretsAllowedRefs`-matched refs.
 */
export type RoleVariant = 'full-grants' | 'no-secret-grants';

/**
 * The gate, applied by the decider at dispatch (spec §12a): which role
 * variant carries this run. Accepts the run's ref in either form — a full
 * `refs/heads/…`/`refs/tags/…` ref is shortened first, while `refs/pull/N`
 * stays full and therefore never matches. Unset means NO ref receives
 * secrets: the shortest onboarding command is the safe one.
 */
export function selectRoleVariant(
  ref: string,
  secretsAllowedRefs: readonly string[] | undefined,
): RoleVariant {
  return matchesAnyRefPattern(shortRefName(ref), secretsAllowedRefs)
    ? 'full-grants'
    : 'no-secret-grants';
}

/**
 * Strip the secret references from a job dispatched under the no-secret
 * variant, BEFORE the buildspec renders: the gated buildspec carries no
 * `env.parameter-store`/`env.secrets-manager` blocks at all, so the job runs
 * without its secrets instead of dying on the role's (correctly) missing
 * grants. Belt to the IAM braces — the variant's policy remains the actual
 * security boundary.
 */
export function gateJobSecrets(job: RunModelJob, variant: RoleVariant): RunModelJob {
  if (variant === 'full-grants' || job.secrets === undefined) {
    return job;
  }
  const { secrets: _stripped, ...gated } = job;
  return gated;
}

/**
 * `secretsAllowedRefs` out of a parsed repo-config document
 * (`/millwright/<name>/repos/<repo>/config`, spec §9.2). Anything malformed
 * narrows to undefined — which the gate reads as "no ref receives secrets".
 * Fail closed, never guess.
 */
export function secretsAllowedRefsFromConfig(config: unknown): readonly string[] | undefined {
  if (typeof config !== 'object' || config === null || Array.isArray(config)) {
    return undefined;
  }
  const value = (config as { secretsAllowedRefs?: unknown }).secretsAllowedRefs;
  if (!Array.isArray(value)) {
    return undefined;
  }
  const patterns = value.filter((entry): entry is string => typeof entry === 'string');
  return patterns.length === value.length ? patterns : undefined;
}
