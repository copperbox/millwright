/**
 * Degradation state machines (spec §6.3), pure and I/O-free:
 *
 * - Quorum circuit breaker: ≥3 repos' SSH *transport* failures in one tick
 *   open it (a GitHub-side or network-side outage, not one bad repo). While
 *   open, full fan-out stops and a single canary repo is probed on a decaying
 *   schedule; one successful probe closes the breaker.
 * - Per-repo quarantine: "Repository not found" / deploy-key rejection are
 *   repo-local, durable conditions. Quarantined repos skip polling and are
 *   retried on their own decaying schedule, self-healing when access returns.
 */

/** Transport failures in one tick that open the breaker (spec §6.3). */
export const BREAKER_QUORUM = 3;

/** Decaying-canary probe schedule caps out at 30 minutes between probes. */
export const MAX_PROBE_INTERVAL_MS = 30 * 60 * 1000;

/** Quarantine retries start at 15 minutes and decay to a 6-hour cadence. */
export const QUARANTINE_BASE_RETRY_MS = 15 * 60 * 1000;
export const MAX_QUARANTINE_RETRY_MS = 6 * 60 * 60 * 1000;

/** The polling table's single circuit-breaker item payload. */
export interface CircuitBreakerState {
  readonly state: 'closed' | 'open';
  /** ISO-8601, set while open. */
  readonly openedAt?: string;
  /** Failed probes since the breaker opened. */
  readonly probeAttempts?: number;
  /** Epoch ms of the next canary probe, while open. */
  readonly nextProbeAt?: number;
}

export const CLOSED_BREAKER: CircuitBreakerState = { state: 'closed' };

export type TickPlan =
  /** Breaker closed — poll every eligible repo. */
  | { readonly mode: 'full' }
  /** Breaker open, probe due — poll one canary repo. */
  | { readonly mode: 'probe' }
  /** Breaker open, probe not due — do nothing this tick. */
  | { readonly mode: 'hold' };

export function planTick(breaker: CircuitBreakerState, nowMs: number): TickPlan {
  if (breaker.state === 'closed') {
    return { mode: 'full' };
  }
  return nowMs >= (breaker.nextProbeAt ?? 0) ? { mode: 'probe' } : { mode: 'hold' };
}

/** Fold a full tick's transport-failure count into the breaker. */
export function afterFullTick(
  transportFailures: number,
  nowMs: number,
  cadenceMs: number,
): CircuitBreakerState {
  if (transportFailures < BREAKER_QUORUM) {
    return CLOSED_BREAKER;
  }
  return {
    state: 'open',
    openedAt: new Date(nowMs).toISOString(),
    probeAttempts: 0,
    nextProbeAt: nowMs + cadenceMs,
  };
}

/** Fold a canary probe's outcome into an open breaker. */
export function afterProbe(
  breaker: CircuitBreakerState,
  succeeded: boolean,
  nowMs: number,
  cadenceMs: number,
): CircuitBreakerState {
  if (succeeded) {
    return CLOSED_BREAKER;
  }
  const attempts = (breaker.probeAttempts ?? 0) + 1;
  return {
    state: 'open',
    openedAt: breaker.openedAt ?? new Date(nowMs).toISOString(),
    probeAttempts: attempts,
    nextProbeAt: nowMs + Math.min(cadenceMs * 2 ** attempts, MAX_PROBE_INTERVAL_MS),
  };
}

/** The polling table's per-repo quarantine marker payload. */
export interface QuarantineState {
  /** Why the repo was quarantined, verbatim for diagnostics. */
  readonly reason: string;
  /** ISO-8601 of the first failure in this quarantine episode. */
  readonly quarantinedAt: string;
  /** Consecutive failed retries in this episode. */
  readonly attempts: number;
  /** Epoch ms after which the repo is polled again. */
  readonly retryAt: number;
}

export function quarantine(
  previous: QuarantineState | undefined,
  reason: string,
  nowMs: number,
): QuarantineState {
  const attempts = (previous?.attempts ?? -1) + 1;
  return {
    reason,
    quarantinedAt: previous?.quarantinedAt ?? new Date(nowMs).toISOString(),
    attempts,
    retryAt: nowMs + Math.min(QUARANTINE_BASE_RETRY_MS * 2 ** attempts, MAX_QUARANTINE_RETRY_MS),
  };
}

/** A quarantined repo is skipped until its retry window opens. */
export function isQuarantineActive(state: QuarantineState | undefined, nowMs: number): boolean {
  return state !== undefined && nowMs < state.retryAt;
}
