import { describe, expect, it } from 'vitest';
import {
  EVENT_DEDUPE_TTL_SECONDS,
  TTL_ATTRIBUTE,
  expiresAtAfterDays,
  expiresAtAfterSeconds,
  isTtlExempt,
  registryKey,
  runKey,
  withMetadataTtl,
} from '../src';

const NOW_MS = 1_776_000_000_000; // fixed instant; tests never read the clock

describe('TTL helpers', () => {
  it('computes epoch-second expiry from days and seconds', () => {
    expect(expiresAtAfterDays(NOW_MS, 90)).toBe(NOW_MS / 1000 + 90 * 86_400);
    expect(expiresAtAfterSeconds(NOW_MS, EVENT_DEDUPE_TTL_SECONDS)).toBe(NOW_MS / 1000 + 1800);
  });

  it('stamps the default 90-day metadata TTL onto items', () => {
    const item = { ...runKey({ repo: 'a/b', workflow: 'ci', runNumber: 1 }), status: 'PENDING' };
    const stamped = withMetadataTtl(item, NOW_MS);
    expect(stamped[TTL_ATTRIBUTE]).toBe(NOW_MS / 1000 + 90 * 86_400);
    expect(stamped.status).toBe('PENDING');
  });

  it('honours a configured retention', () => {
    const item = runKey({ repo: 'a/b', workflow: 'ci', runNumber: 1 });
    expect(withMetadataTtl(item, NOW_MS, 30)[TTL_ATTRIBUTE]).toBe(NOW_MS / 1000 + 30 * 86_400);
  });

  it('refuses to stamp TTL-exempt REG# registry rows', () => {
    const registry = registryKey('a/b', 'main');
    expect(isTtlExempt(registry.pk)).toBe(true);
    expect(() => withMetadataTtl(registry, NOW_MS)).toThrow(/TTL-exempt/);
  });

  it('treats every non-registry partition as TTL-carrying', () => {
    for (const pk of ['WF#a/b#ci', 'RUN#a/b#ci#1', 'EVENT#a/b#main#abc#push', 'BUILD#x', 'GROUP#g', 'CHECK#a/b#abc']) {
      expect(isTtlExempt(pk)).toBe(false);
    }
  });

  it('rejects nonsense inputs', () => {
    expect(() => expiresAtAfterSeconds(-1, 60)).toThrow();
    expect(() => expiresAtAfterSeconds(NOW_MS, 0)).toThrow();
    expect(() => expiresAtAfterDays(NOW_MS, -1)).toThrow();
  });
});
