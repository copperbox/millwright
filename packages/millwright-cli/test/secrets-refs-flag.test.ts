import { describe, expect, it } from 'vitest';
import { CommandError } from '../src/config-plane';
import { assertSecretsRefPatterns, secretsRefPatternError } from '../src/secrets-refs-flag';

describe('secretsRefPatternError', () => {
  it('rejects refs/heads/ patterns and suggests the short name', () => {
    expect(secretsRefPatternError('refs/heads/main')).toBe(
      '"refs/heads/main" will never match — secretsAllowedRefs patterns use short ref names; did you mean "main"?',
    );
  });

  it('rejects refs/tags/ patterns, globs included, and suggests the short name', () => {
    expect(secretsRefPatternError('refs/tags/v*')).toBe(
      '"refs/tags/v*" will never match — secretsAllowedRefs patterns use short ref names; did you mean "v*"?',
    );
  });

  it('rejects other refs/ namespaces without inventing a suggestion', () => {
    const message = secretsRefPatternError('refs/pull/*/head');
    expect(message).toContain('"refs/pull/*/head" will never match');
    expect(message).toContain('short ref names');
    expect(message).not.toContain('did you mean');
  });

  it('rejects a bare refs/ prefix glob', () => {
    expect(secretsRefPatternError('refs/*')).toContain('will never match');
  });

  it('accepts short names and globs', () => {
    for (const pattern of ['main', 'release/*', 'v*', '*', 'release/1.2', 'refs-cleanup']) {
      expect(secretsRefPatternError(pattern)).toBeUndefined();
    }
  });
});

describe('assertSecretsRefPatterns', () => {
  it('throws a CommandError naming the first offending pattern', () => {
    expect(() => assertSecretsRefPatterns(['main', 'refs/heads/develop', 'refs/tags/v*'])).toThrow(
      CommandError,
    );
    expect(() => assertSecretsRefPatterns(['main', 'refs/heads/develop', 'refs/tags/v*'])).toThrow(
      /"refs\/heads\/develop" will never match .* did you mean "develop"\?/,
    );
  });

  it('passes an all-short list and an undefined one through untouched', () => {
    expect(() => assertSecretsRefPatterns(['main', 'release/*', 'v*'])).not.toThrow();
    expect(() => assertSecretsRefPatterns(undefined)).not.toThrow();
    expect(() => assertSecretsRefPatterns([])).not.toThrow();
  });
});
