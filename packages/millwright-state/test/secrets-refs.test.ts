import { describe, expect, it } from 'vitest';
import { matchesAllowedRefPattern, refReceivesSecrets, selectJobRoleVariant } from '../src';
// `shortRefName` here is secrets-refs' own ref → short-name-or-undefined helper, distinct
// from (and not re-exported alongside) the bus-events `shortRefName`, which never returns
// undefined. Imported directly from the module rather than the package root to avoid a
// same-name export collision at the public API.
import { shortRefName } from '../src/secrets-refs';

describe('shortRefName', () => {
  it.each([
    ['refs/heads/main', 'main'],
    ['refs/heads/release/1.2', 'release/1.2'],
    ['refs/tags/v1.0.0', 'v1.0.0'],
    ['main', 'main'],
    ['release/1.2', 'release/1.2'],
  ])('%s → %s', (ref, expected) => {
    expect(shortRefName(ref)).toBe(expected);
  });

  it.each([
    ['refs/pull/42/head'],
    ['refs/pull/42/merge'],
    ['refs/notes/commits'],
    ['refs/heads/'],
    [''],
  ])('%s has no short name', (ref) => {
    expect(shortRefName(ref)).toBeUndefined();
  });
});

describe('matchesAllowedRefPattern — the §12a test table', () => {
  it.each([
    // [shortName, pattern, matches]
    ['main', 'main', true],
    ['mainline', 'main', false], // anchored: never a prefix match
    ['main', 'mainline', false],
    ['main', '*', true],
    ['release/1.2', 'release/*', true],
    ['release/1.2/hotfix', 'release/*', true], // * crosses '/'
    ['release', 'release/*', false],
    ['prerelease/1', '*release/*', true],
    ['v1.2.3', 'v*', true],
    ['v1x2x3', 'v1.2.3', false], // '.' is literal, not a metacharacter
    ['v1.2.3', 'v1.2.3', true],
    ['main', '', false],
    ['a+b', 'a+b', true], // regex specials in patterns stay literal
    ['axb', 'a+b', false],
  ])('"%s" against "%s" → %s', (shortName, pattern, expected) => {
    expect(matchesAllowedRefPattern(shortName, pattern)).toBe(expected);
  });
});

describe('refReceivesSecrets', () => {
  it('fails closed on an unset allowlist', () => {
    expect(refReceivesSecrets('refs/heads/main', undefined)).toBe(false);
  });

  it('fails closed on an empty allowlist', () => {
    expect(refReceivesSecrets('refs/heads/main', [])).toBe(false);
  });

  it('matches an allowlisted branch by short name', () => {
    expect(refReceivesSecrets('refs/heads/main', ['main'])).toBe(true);
    expect(refReceivesSecrets('refs/heads/release/1.2', ['release/*'])).toBe(true);
    expect(refReceivesSecrets('refs/tags/v1.0.0', ['v*'])).toBe(true);
  });

  it('never matches PR refs, whatever the allowlist says', () => {
    expect(refReceivesSecrets('refs/pull/42/head', ['*'])).toBe(false);
    expect(refReceivesSecrets('refs/pull/42/merge', ['refs/pull/*', 'pull/*', '*'])).toBe(false);
  });

  it('never matches unknown ref namespaces', () => {
    expect(refReceivesSecrets('refs/notes/commits', ['*'])).toBe(false);
  });
});

describe('selectJobRoleVariant', () => {
  it('selects full-grants only for allowlisted refs', () => {
    expect(selectJobRoleVariant('refs/heads/main', ['main'])).toBe('full');
    expect(selectJobRoleVariant('refs/heads/feature', ['main'])).toBe('no-secret');
    expect(selectJobRoleVariant('refs/pull/7/merge', ['*'])).toBe('no-secret');
    expect(selectJobRoleVariant('refs/heads/main', undefined)).toBe('no-secret');
  });
});
