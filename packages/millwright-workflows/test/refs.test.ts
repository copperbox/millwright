import { describe, expect, it } from 'vitest';
import { matchesAnyRefPattern, matchesRefPattern } from '../src';

// The spec §12a matcher ships with a test table: patterns match the short ref
// name as pushed, anchored at both ends; `*` is the only metacharacter and
// crosses `/`; no implicit prefix/substring behavior.
const TABLE: Array<[ref: string, pattern: string, matches: boolean]> = [
  ['main', 'main', true],
  ['mainline', 'main', false], // anchored: never a prefix match
  ['main', 'mainline', false],
  ['main', '*', true],
  ['release/1.2', 'release/*', true],
  ['release/1.2/hotfix', 'release/*', true], // * crosses /
  ['release', 'release/*', false],
  ['prerelease/1.2', 'release/*', false],
  ['v1.4.2', 'v*', true],
  ['v1.4.2', 'v*.*.*', true],
  ['va', 'v*.*.*', false],
  ['main', '', false],
  ['release/1.2', '*/1.2', true],
  ['feature.x', 'feature.x', true],
  ['featureAx', 'feature.x', false], // "." is literal, not a regex any-char
  ['deep/nested/branch', '*', true],
];

describe('matchesRefPattern (§12a table)', () => {
  it.each(TABLE)('ref %j vs pattern %j -> %s', (ref, pattern, expected) => {
    expect(matchesRefPattern(ref, pattern)).toBe(expected);
  });

  it('never matches full refs — PR run identities are structurally unmatchable', () => {
    expect(matchesRefPattern('refs/pull/7', '*')).toBe(false);
    expect(matchesRefPattern('refs/pull/7', 'refs/pull/*')).toBe(false);
    expect(matchesRefPattern('refs/heads/main', 'main')).toBe(false);
  });
});

describe('matchesAnyRefPattern', () => {
  it('matches when any pattern matches', () => {
    expect(matchesAnyRefPattern('release/1.2', ['main', 'release/*'])).toBe(true);
    expect(matchesAnyRefPattern('feature/x', ['main', 'release/*'])).toBe(false);
  });

  it('an unset or empty allowlist matches no ref — the default is the safe one', () => {
    expect(matchesAnyRefPattern('main', undefined)).toBe(false);
    expect(matchesAnyRefPattern('main', [])).toBe(false);
  });
});
