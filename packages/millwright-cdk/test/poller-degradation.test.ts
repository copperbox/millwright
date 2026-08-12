import { describe, expect, it } from 'vitest';
import {
  BREAKER_QUORUM,
  CLOSED_BREAKER,
  MAX_PROBE_INTERVAL_MS,
  MAX_PR_BACKOFF_MS,
  MAX_QUARANTINE_RETRY_MS,
  QUARANTINE_BASE_RETRY_MS,
  afterFullTick,
  afterProbe,
  isPrBackoffActive,
  isQuarantineActive,
  planTick,
  prBackoff,
  quarantine,
} from '../src/runtime/poller/degradation';

const NOW = 1_700_000_000_000;
const CADENCE = 60_000;

describe('quorum circuit breaker (spec §6.3)', () => {
  it('stays closed below the quorum of transport failures', () => {
    expect(afterFullTick(BREAKER_QUORUM - 1, NOW, CADENCE)).toEqual(CLOSED_BREAKER);
  });

  it('opens at quorum and schedules the first canary probe one cadence out', () => {
    const breaker = afterFullTick(BREAKER_QUORUM, NOW, CADENCE);
    expect(breaker.state).toBe('open');
    expect(breaker.nextProbeAt).toBe(NOW + CADENCE);
  });

  it('plans full ticks while closed, probes when due, holds otherwise', () => {
    expect(planTick(CLOSED_BREAKER, NOW)).toEqual({ mode: 'full' });
    const open = afterFullTick(BREAKER_QUORUM, NOW, CADENCE);
    expect(planTick(open, NOW + CADENCE - 1)).toEqual({ mode: 'hold' });
    expect(planTick(open, NOW + CADENCE)).toEqual({ mode: 'probe' });
  });

  it('decays the canary schedule on failed probes, capped at 30 minutes', () => {
    let breaker = afterFullTick(BREAKER_QUORUM, NOW, CADENCE);
    breaker = afterProbe(breaker, false, NOW + CADENCE, CADENCE);
    expect(breaker.nextProbeAt).toBe(NOW + CADENCE + 2 * CADENCE);
    breaker = afterProbe(breaker, false, NOW + 10 * CADENCE, CADENCE);
    expect(breaker.nextProbeAt).toBe(NOW + 10 * CADENCE + 4 * CADENCE);
    for (let i = 0; i < 10; i += 1) {
      breaker = afterProbe(breaker, false, NOW, CADENCE);
    }
    expect(breaker.nextProbeAt).toBe(NOW + MAX_PROBE_INTERVAL_MS);
    expect(breaker.openedAt).toBeDefined();
  });

  it('closes on the first successful probe', () => {
    const open = afterFullTick(BREAKER_QUORUM, NOW, CADENCE);
    expect(afterProbe(open, true, NOW + CADENCE, CADENCE)).toEqual(CLOSED_BREAKER);
  });
});

describe('per-repo quarantine (spec §6.3)', () => {
  it('starts with the base retry window and preserves the episode start', () => {
    const first = quarantine(undefined, 'Repository not found.', NOW);
    expect(first.attempts).toBe(0);
    expect(first.retryAt).toBe(NOW + QUARANTINE_BASE_RETRY_MS);
    expect(first.quarantinedAt).toBe(new Date(NOW).toISOString());

    const later = NOW + QUARANTINE_BASE_RETRY_MS;
    const second = quarantine(first, 'Repository not found.', later);
    expect(second.attempts).toBe(1);
    expect(second.retryAt).toBe(later + 2 * QUARANTINE_BASE_RETRY_MS);
    expect(second.quarantinedAt).toBe(first.quarantinedAt);
  });

  it('caps the retry decay at six hours', () => {
    let state = quarantine(undefined, 'key rejected', NOW);
    for (let i = 0; i < 12; i += 1) {
      state = quarantine(state, 'key rejected', NOW);
    }
    expect(state.retryAt).toBe(NOW + MAX_QUARANTINE_RETRY_MS);
  });

  it('is active until the retry window opens', () => {
    const state = quarantine(undefined, 'nope', NOW);
    expect(isQuarantineActive(state, state.retryAt - 1)).toBe(true);
    expect(isQuarantineActive(state, state.retryAt)).toBe(false);
    expect(isQuarantineActive(undefined, NOW)).toBe(false);
  });
});

describe('tier-2 backoff (spec §6.3)', () => {
  it('starts around one cadence with equal jitter', () => {
    const low = prBackoff(undefined, NOW, CADENCE, () => 0);
    const high = prBackoff(undefined, NOW, CADENCE, () => 1);
    expect(low).toEqual({ attempts: 1, retryAt: NOW + CADENCE / 2 });
    expect(high).toEqual({ attempts: 1, retryAt: NOW + CADENCE });
  });

  it('decays exponentially and caps at 30 minutes', () => {
    let state = prBackoff(undefined, NOW, CADENCE, () => 1);
    expect(prBackoff(state, NOW, CADENCE, () => 1).retryAt).toBe(NOW + 2 * CADENCE);
    for (let i = 0; i < 12; i += 1) {
      state = prBackoff(state, NOW, CADENCE, () => 1);
    }
    expect(state.retryAt).toBe(NOW + MAX_PR_BACKOFF_MS);
  });

  it('floors the retry at an announced rate-limit reset, plus jitter', () => {
    const reset = NOW + 15 * 60 * 1000;
    const state = prBackoff(undefined, NOW, CADENCE, () => 0.5, reset);
    expect(state.retryAt).toBe(reset + CADENCE / 2);
    // A reset already inside the jittered window changes nothing.
    const near = prBackoff(undefined, NOW, CADENCE, () => 0.5, NOW + 1);
    expect(near.retryAt).toBe(NOW + CADENCE * 0.75);
  });

  it('is active until the retry window opens', () => {
    const state = prBackoff(undefined, NOW, CADENCE, () => 0.5);
    expect(isPrBackoffActive(state, state.retryAt - 1)).toBe(true);
    expect(isPrBackoffActive(state, state.retryAt)).toBe(false);
    expect(isPrBackoffActive(undefined, NOW)).toBe(false);
  });
});
