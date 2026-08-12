import { describe, expect, it } from 'vitest';
import {
  CIRCUIT_BREAKER_KEY,
  KeyFormatError,
  cronLastFiredKey,
  parseRepoPollingKey,
  prEtagKey,
  quarantineKey,
  refMapKey,
} from '../src';

const REPO = 'copperbox/millwright';

describe('polling-table keys', () => {
  it('keeps all per-repo rows in one partition', () => {
    const partitions = new Set(
      [refMapKey(REPO), prEtagKey(REPO), quarantineKey(REPO), cronLastFiredKey(REPO, 'ci', '0 4 * * *')].map(
        (k) => k.pk,
      ),
    );
    expect(partitions).toEqual(new Set([`REPO#${REPO}`]));
  });

  it('round-trips the fixed per-repo rows', () => {
    expect(parseRepoPollingKey(refMapKey(REPO))).toEqual({ repo: REPO, kind: 'refs' });
    expect(parseRepoPollingKey(prEtagKey(REPO))).toEqual({ repo: REPO, kind: 'pr-etag' });
    expect(parseRepoPollingKey(quarantineKey(REPO))).toEqual({ repo: REPO, kind: 'quarantine' });
  });

  it('round-trips cron last-fired rows per (workflow, expression)', () => {
    const key = cronLastFiredKey(REPO, 'nightly', '30 4 * * 1-5');
    expect(key.sk).toBe('CRON#nightly#30 4 * * 1-5');
    expect(parseRepoPollingKey(key)).toEqual({
      repo: REPO,
      kind: 'cron',
      workflow: 'nightly',
      expression: '30 4 * * 1-5',
    });
  });

  it('has a single deployment-wide circuit-breaker item', () => {
    expect(CIRCUIT_BREAKER_KEY).toEqual({ pk: 'CIRCUIT', sk: '-' });
  });

  it('rejects malformed keys', () => {
    expect(() => cronLastFiredKey(REPO, 'ci', 'has#hash')).toThrow(KeyFormatError);
    expect(() => parseRepoPollingKey({ pk: 'CIRCUIT', sk: '-' })).toThrow(KeyFormatError);
    expect(() => parseRepoPollingKey({ pk: `REPO#${REPO}`, sk: 'MYSTERY' })).toThrow(KeyFormatError);
  });
});
