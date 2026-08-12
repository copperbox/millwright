import { describe, expect, it } from 'vitest';
import { DEFAULT_REPO_POLLING_CONFIG, parseRepoPollingConfig } from '../src';

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
