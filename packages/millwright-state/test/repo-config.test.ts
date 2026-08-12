import { describe, expect, it } from 'vitest';
import {
  RepoConfigFormatError,
  defaultRepoConfig,
  parseRepoConfig,
  serializeRepoConfig,
} from '../src';

describe('defaultRepoConfig', () => {
  it('is the safe onboarding shape: no secrets refs, PR polling on, fork PRs off', () => {
    expect(defaultRepoConfig()).toEqual({
      secretsAllowedRefs: [],
      prPolling: true,
      forkPrPolicy: 'off',
      ecrPullRepos: [],
    });
  });
});

describe('serializeRepoConfig / parseRepoConfig', () => {
  it('round-trips every field', () => {
    const config = {
      secretsAllowedRefs: ['main', 'release/*'],
      prPolling: false,
      forkPrPolicy: 'on' as const,
      ecrPullRepos: ['arn:aws:ecr:us-east-1:123456789012:repository/tools'],
    };
    expect(parseRepoConfig(serializeRepoConfig(config))).toEqual(config);
  });

  it('fills spec defaults for fields absent from the stored JSON', () => {
    expect(parseRepoConfig('{}')).toEqual(defaultRepoConfig());
  });

  it('rejects unparseable JSON and non-object values', () => {
    expect(() => parseRepoConfig('not json')).toThrow(RepoConfigFormatError);
    expect(() => parseRepoConfig('[1]')).toThrow(RepoConfigFormatError);
    expect(() => parseRepoConfig('null')).toThrow(RepoConfigFormatError);
  });

  it('rejects wrongly-typed fields rather than guessing', () => {
    expect(() => parseRepoConfig('{"secretsAllowedRefs":"main"}')).toThrow(RepoConfigFormatError);
    expect(() => parseRepoConfig('{"secretsAllowedRefs":[1]}')).toThrow(RepoConfigFormatError);
    expect(() => parseRepoConfig('{"prPolling":"yes"}')).toThrow(RepoConfigFormatError);
    expect(() => parseRepoConfig('{"forkPrPolicy":"maybe"}')).toThrow(RepoConfigFormatError);
    expect(() => parseRepoConfig('{"ecrPullRepos":{}}')).toThrow(RepoConfigFormatError);
  });

  it('serializes deterministically with a stable key order', () => {
    const a = serializeRepoConfig(defaultRepoConfig());
    const b = serializeRepoConfig({ ...defaultRepoConfig() });
    expect(a).toBe(b);
    expect(JSON.parse(a)).toEqual(defaultRepoConfig());
  });
});
