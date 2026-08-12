/**
 * The `secretsAllowedRefs` matcher and the secrets gate (spec §12a).
 *
 * Patterns match the SHORT ref name as pushed (`main`, `release/1.2`, tag
 * names likewise), anchored at both ends; `*` is the only metacharacter and
 * crosses `/`; there is no implicit prefix or substring behavior — `main`
 * matches exactly `main`, never `mainline`.
 *
 * Enforcement is the decider's, at dispatch, via job-role variant selection
 * (spec §10.2): a matched ref runs under the full-grants variant, everything
 * else under no-secret-grants. Synth-time checks are fail-fast UX only.
 */

import { JobRoleVariant } from './job-roles';

/**
 * Short name of a fully qualified ref, or undefined when the ref has no short
 * name and is therefore structurally unmatchable:
 *
 * - `refs/heads/<name>` / `refs/tags/<name>` → `<name>`
 * - `refs/pull/…` → undefined — PR runs never receive secrets, as a rule of
 *   the dialect rather than an emergent property
 * - any other `refs/…` namespace → undefined (fail-closed)
 * - a name with no `refs/` prefix is already short and returned as-is
 */
export function shortRefName(ref: string): string | undefined {
  if (ref.startsWith('refs/heads/')) {
    return ref.slice('refs/heads/'.length) || undefined;
  }
  if (ref.startsWith('refs/tags/')) {
    return ref.slice('refs/tags/'.length) || undefined;
  }
  if (ref.startsWith('refs/')) {
    return undefined;
  }
  return ref || undefined;
}

/**
 * One pattern against one short ref name: anchored at both ends, `*` matches
 * any run of characters (crossing `/`), every other character is literal.
 */
export function matchesAllowedRefPattern(shortName: string, pattern: string): boolean {
  if (!pattern) {
    return false;
  }
  const anchored = pattern
    .split('*')
    .map((literal) => literal.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
    .join('.*');
  return new RegExp(`^${anchored}$`).test(shortName);
}

/**
 * The gate: does this ref receive secrets under this allowlist?
 *
 * Unset (or empty) allowlist means NO ref receives secrets — the shortest
 * onboarding command is the safe one. Refs without a short name (PR refs,
 * unknown namespaces) never match.
 */
export function refReceivesSecrets(
  ref: string,
  secretsAllowedRefs: readonly string[] | undefined,
): boolean {
  if (!secretsAllowedRefs || secretsAllowedRefs.length === 0) {
    return false;
  }
  const shortName = shortRefName(ref);
  if (shortName === undefined) {
    return false;
  }
  return secretsAllowedRefs.some((pattern) => matchesAllowedRefPattern(shortName, pattern));
}

/**
 * Dispatch-time variant selection (spec §10.2): full-grants only for refs the
 * allowlist matches, no-secret-grants for everything else.
 */
export function selectJobRoleVariant(
  ref: string,
  secretsAllowedRefs: readonly string[] | undefined,
): JobRoleVariant {
  return refReceivesSecrets(ref, secretsAllowedRefs) ? 'full' : 'no-secret';
}
