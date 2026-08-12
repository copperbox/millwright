import { describe, expect, it } from 'vitest';
import {
  DEFAULT_REPO_POLLING_CONFIG,
  RepoConfigFormatError,
  defaultRepoConfig,
  parseRepoConfig,
  parseRepoPollingConfig,
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

describe('repo config parameter parsing (spec §9.2)', () => {
  it('defaults: PR polling on, fork-PR policy off', () => {
    expect(DEFAULT_REPO_POLLING_CONFIG).toEqual({ prPolling: true, forkPrPolicy: false });
    expect(parseRepoPollingConfig(undefined)).toEqual(DEFAULT_REPO_POLLING_CONFIG);
    expect(parseRepoPollingConfig('{}')).toEqual(DEFAULT_REPO_POLLING_CONFIG);
  });

  it('reads booleans and the CLI\'s on/off strings', () => {
    expect(parseRepoPollingConfig('{"prPolling":false}')).toEqual({
      prPolling: false,
      forkPrPolicy: false,
    });
    expect(parseRepoPollingConfig('{"prPolling":"off","forkPrPolicy":"on"}')).toEqual({
      prPolling: false,
      forkPrPolicy: true,
    });
    expect(parseRepoPollingConfig('{"forkPrPolicy":true}')).toEqual({
      prPolling: true,
      forkPrPolicy: true,
    });
  });

  it('degrades unreadable or malformed documents to the defaults', () => {
    expect(parseRepoPollingConfig('not json')).toEqual(DEFAULT_REPO_POLLING_CONFIG);
    expect(parseRepoPollingConfig('[1,2]')).toEqual(DEFAULT_REPO_POLLING_CONFIG);
    expect(parseRepoPollingConfig('"just a string"')).toEqual(DEFAULT_REPO_POLLING_CONFIG);
    expect(parseRepoPollingConfig('{"prPolling":42,"forkPrPolicy":"maybe"}')).toEqual(
      DEFAULT_REPO_POLLING_CONFIG,
    );
  });

  it('ignores unrelated fields sharing the parameter', () => {
    const json = JSON.stringify({
      secretsAllowedRefs: ['main'],
      ecrPullRepos: [],
      forkPrPolicy: 'on',
    });
    expect(parseRepoPollingConfig(json)).toEqual({ prPolling: true, forkPrPolicy: true });
  });
});
