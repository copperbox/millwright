/**
 * Fail-fast validation of operator-typed `secretsAllowedRefs` patterns
 * (`repo add/update --secrets-refs`, `synth --secrets-allowed-refs`).
 *
 * The matcher (millwright-state `secrets-refs.ts`) shortens the run's ref to
 * `main` / `v1.2` before matching, anchored at both ends, so a pattern that
 * itself starts with `refs/` can never match anything. Stored verbatim, such a
 * pattern silently puts every run under the no-secret role variant — so the
 * CLI rejects it rather than rewriting it, keeping the stored config exactly
 * what the operator typed (fail-closed, spec §12a).
 */

import { CommandError } from './config-plane';

const REF_PREFIX = 'refs/';

/** `refs/heads/x` / `refs/tags/x` → `x`; no suggestion for other namespaces. */
function shortFormSuggestion(pattern: string): string | undefined {
  const match = pattern.match(/^refs\/(?:heads|tags)\/(.+)$/);
  return match ? match[1] : undefined;
}

/**
 * The error message for a pattern the matcher can never satisfy, or
 * undefined when the pattern is a plain short-name pattern.
 */
export function secretsRefPatternError(pattern: string): string | undefined {
  if (!pattern.startsWith(REF_PREFIX)) {
    return undefined;
  }
  const suggestion = shortFormSuggestion(pattern);
  const base = `"${pattern}" will never match — secretsAllowedRefs patterns use short ref names`;
  return suggestion === undefined
    ? `${base} (no refs/heads/ or refs/tags/ prefix)`
    : `${base}; did you mean "${suggestion}"?`;
}

/** Throw a user-facing CommandError for the first unmatchable pattern. */
export function assertSecretsRefPatterns(patterns: readonly string[] | undefined): void {
  for (const pattern of patterns ?? []) {
    const message = secretsRefPatternError(pattern);
    if (message !== undefined) {
      throw new CommandError(message);
    }
  }
}
