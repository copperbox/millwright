import { describe, expect, it } from 'vitest';
import {
  RunModelJob,
  buildspecForJob,
  gateJobSecrets,
  matchesAnyRefPattern,
  matchesRefPattern,
  secretsAllowedRefsFromConfig,
  selectRoleVariant,
} from '../src';

// The spec §12a matcher ships with a test table: patterns match the short
// ref name as pushed, anchored at both ends; `*` is the only metacharacter
// and crosses `/`; no implicit prefix/substring behavior.
const TABLE: Array<[ref: string, pattern: string, matches: boolean]> = [
  ['main', 'main', true],
  ['mainline', 'main', false], // anchored: never a prefix match
  ['main', 'mainline', false],
  ['main', '*', true],
  ['release/1.2', 'release/*', true],
  ['release/x/y', 'release/*', true], // * crosses /
  ['release', 'release/*', false],
  ['prerelease/1.2', 'release/*', false],
  ['v1.4.2', 'v*', true],
  ['v1.4.2', 'v*.*.*', true],
  ['va', 'v*.*.*', false],
  ['main', '', false],
  ['release/1.2', '*/1.2', true],
  ['feature.x', 'feature.x', true],
  ['featureAx', 'feature.x', false], // "." is literal, not regex any-char
  ['deep/nested/branch', '*', true],
];

describe('matchesRefPattern (§12a table)', () => {
  it.each(TABLE)('ref %j vs pattern %j -> %s', (ref, pattern, expected) => {
    expect(matchesRefPattern(ref, pattern)).toBe(expected);
  });

  it('never matches full refs — refs/pull/7 matches nothing', () => {
    expect(matchesRefPattern('refs/pull/7', '*')).toBe(false);
    expect(matchesRefPattern('refs/pull/7', 'refs/pull/*')).toBe(false);
    expect(matchesRefPattern('refs/heads/main', 'main')).toBe(false);
  });

  it('an unset or empty allowlist matches no ref', () => {
    expect(matchesAnyRefPattern('main', undefined)).toBe(false);
    expect(matchesAnyRefPattern('main', [])).toBe(false);
    expect(matchesAnyRefPattern('release/1.2', ['main', 'release/*'])).toBe(true);
  });
});

describe('selectRoleVariant — the gate at dispatch (§10.2)', () => {
  it('unset secretsAllowedRefs means NO ref receives secrets', () => {
    expect(selectRoleVariant('main', undefined)).toBe('no-secret-grants');
    expect(selectRoleVariant('refs/heads/main', undefined)).toBe('no-secret-grants');
    expect(selectRoleVariant('main', [])).toBe('no-secret-grants');
  });

  it('matched refs get the full variant, in short or full-ref form', () => {
    expect(selectRoleVariant('main', ['main'])).toBe('full-grants');
    expect(selectRoleVariant('refs/heads/main', ['main'])).toBe('full-grants');
    expect(selectRoleVariant('refs/tags/v1.2.0', ['v*'])).toBe('full-grants');
    expect(selectRoleVariant('refs/heads/release/1.2', ['release/*'])).toBe('full-grants');
  });

  it('unmatched refs and PR refs are always no-secret', () => {
    expect(selectRoleVariant('feature/x', ['main', 'release/*'])).toBe('no-secret-grants');
    expect(selectRoleVariant('refs/pull/7', ['*'])).toBe('no-secret-grants');
    expect(selectRoleVariant('refs/pull/7', ['refs/pull/*'])).toBe('no-secret-grants');
  });
});

const SECRET_JOB: RunModelJob = {
  name: 'publish',
  image: 'registry.example.com/node:22',
  steps: [{ run: 'npm publish' }],
  secrets: {
    NPM_TOKEN: { parameter: 'npm-token' },
    HUB: { secretsManager: 'arn:aws:secretsmanager:us-east-1:1:secret:hub' },
  },
};

describe('gateJobSecrets', () => {
  it('strips secrets for the no-secret variant and keeps everything else', () => {
    const gated = gateJobSecrets(SECRET_JOB, 'no-secret-grants');
    expect(gated.secrets).toBeUndefined();
    expect(gated.name).toBe('publish');
    expect(gated.steps).toEqual(SECRET_JOB.steps);
  });

  it('passes the job through untouched for the full variant', () => {
    expect(gateJobSecrets(SECRET_JOB, 'full-grants')).toBe(SECRET_JOB);
  });

  it('a gated job renders a buildspec with NO secret env blocks', () => {
    const ctx = { deploymentName: 'ci', repo: 'octo/app' };
    const full = buildspecForJob(SECRET_JOB, ctx);
    expect(full.env['parameter-store']).toBeDefined();
    expect(full.env['secrets-manager']).toBeDefined();

    const gated = buildspecForJob(gateJobSecrets(SECRET_JOB, 'no-secret-grants'), ctx);
    expect(gated.env['parameter-store']).toBeUndefined();
    expect(gated.env['secrets-manager']).toBeUndefined();
    // The steps still run — the job proceeds without its secrets rather
    // than dying on the missing grants.
    expect(gated.phases.build.commands).toEqual(full.phases.build.commands);
  });
});

describe('secretsAllowedRefsFromConfig', () => {
  it('reads well-formed configs', () => {
    expect(secretsAllowedRefsFromConfig({ secretsAllowedRefs: ['main', 'release/*'] })).toEqual([
      'main',
      'release/*',
    ]);
    expect(secretsAllowedRefsFromConfig({ secretsAllowedRefs: [] })).toEqual([]);
  });

  it('narrows anything malformed to undefined — the gate reads that as no-secrets', () => {
    expect(secretsAllowedRefsFromConfig(undefined)).toBeUndefined();
    expect(secretsAllowedRefsFromConfig({})).toBeUndefined();
    expect(secretsAllowedRefsFromConfig({ secretsAllowedRefs: 'main' })).toBeUndefined();
    expect(secretsAllowedRefsFromConfig({ secretsAllowedRefs: ['main', 42] })).toBeUndefined();
    expect(secretsAllowedRefsFromConfig('nonsense')).toBeUndefined();
    expect(selectRoleVariant('main', secretsAllowedRefsFromConfig({}))).toBe('no-secret-grants');
  });
});
