/**
 * The `secretsAllowedRefs` matcher (spec §12a).
 *
 * Patterns match the short ref name as pushed (`main`, `release/1.2`, tag
 * names likewise), anchored at both ends. `*` is the only metacharacter and
 * crosses `/`. There is no implicit prefix or substring behavior: `main`
 * matches exactly `main`, never `mainline`.
 *
 * Enforcement lives in the decider at dispatch; synth-time use of this
 * matcher is fail-fast UX only.
 */

const escapeRegExp = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

export function matchesRefPattern(shortRef: string, pattern: string): boolean {
  // A run identity that is still a full ref (e.g. a PR run's `refs/pull/N`)
  // is never a short name and never matches — this is what makes "no secrets
  // on PR runs" structural rather than emergent.
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
