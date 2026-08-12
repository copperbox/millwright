import {
  CheckStateItem,
  DesiredCheckState,
  checkBackoffSeconds,
  isCheckUnconvergedPastDeadline,
  parseDesiredCheckState,
} from '@copperbox/millwright-state';

/**
 * The reporter's reconciliation core (spec §13.2, C8): converge one check
 * item's reported state onto its desired state. Pure orchestration —
 * DynamoDB access and GitHub calls arrive as dependencies.
 *
 * Both entry paths (stream records and the 1-min sweep) funnel into
 * `reconcileCheck`, which re-reads the item and posts its LATEST desired
 * state — outage replay therefore coalesces to one GitHub call per check no
 * matter how many desired writes queued up behind the outage.
 */

export interface CheckCoordinates {
  readonly repo: string;
  readonly sha: string;
  readonly context: string;
}

export interface ReporterStore {
  getCheck(coords: CheckCoordinates): Promise<CheckStateItem | undefined>;
  /**
   * Record GitHub's acknowledgement, conditional on `desired` still equalling
   * `seenDesired` — `stale` means a newer desired state landed mid-flight and
   * its own stream record will reconcile it.
   */
  markReported(
    coords: CheckCoordinates,
    seenDesired: string,
    checkRunId?: number,
  ): Promise<'applied' | 'stale'>;
  /** Persist a minted check-run id even when the reported write went stale. */
  recordCheckRunId(coords: CheckCoordinates, checkRunId: number): Promise<void>;
  recordAttemptFailure(
    coords: CheckCoordinates,
    backoffAttempts: number,
    nextAttemptAt: string,
  ): Promise<void>;
  markAbandoned(coords: CheckCoordinates): Promise<void>;
  /** Sweep input: items with a desired ≠ reported, not yet abandoned. */
  listUnconverged(): Promise<CheckStateItem[]>;
}

/** A failed GitHub call; `retryAfterSeconds` mirrors a Retry-After header. */
export class PublishFailure extends Error {
  constructor(
    message: string,
    readonly retryAfterSeconds?: number,
    readonly status?: number,
  ) {
    super(message);
  }
}

export interface CheckPublisher {
  /**
   * Post the desired state to GitHub: create or update a check run (App
   * mode) or create a commit status (PAT mode). Returns the check-run id
   * when one exists so the item carries it forward.
   */
  publish(
    coords: CheckCoordinates,
    desired: DesiredCheckState,
    checkRunId?: number,
  ): Promise<{ checkRunId?: number }>;
}

export interface ReporterDeps {
  readonly store: ReporterStore;
  readonly publisher: CheckPublisher;
  readonly log: (message: string, fields?: Record<string, unknown>) => void;
}

export type ReconcileDisposition =
  | 'missing'
  | 'no-desired'
  | 'abandoned-skip'
  | 'converged'
  | 'abandoned'
  | 'waiting'
  | 'reported'
  | 'superseded'
  | 'backed-off';

export async function reconcileCheck(
  deps: ReporterDeps,
  coords: CheckCoordinates,
  nowMs: number,
): Promise<ReconcileDisposition> {
  const item = await deps.store.getCheck(coords);
  if (!item) {
    return 'missing';
  }
  if (!item.desired) {
    return 'no-desired';
  }
  if (item.abandoned) {
    return 'abandoned-skip';
  }
  if (item.reported === item.desired) {
    return 'converged';
  }
  // The abandonment deadline outranks the backoff gate: an item that has
  // been unconverged for 7 days stops being retried even mid-backoff.
  if (item.desiredAt && isCheckUnconvergedPastDeadline(item.desiredAt, nowMs)) {
    await deps.store.markAbandoned(coords);
    deps.log('check abandoned after 7 unconverged days', { ...coords });
    return 'abandoned';
  }
  if (item.nextAttemptAt && Date.parse(item.nextAttemptAt) > nowMs) {
    return 'waiting';
  }

  let desired: DesiredCheckState;
  try {
    desired = parseDesiredCheckState(item.desired);
  } catch (err) {
    // Unpostable forever — abandon rather than burn the backoff loop on it.
    await deps.store.markAbandoned(coords);
    deps.log('check abandoned: desired state unparseable', {
      ...coords,
      error: (err as Error).message,
    });
    return 'abandoned';
  }

  try {
    const result = await deps.publisher.publish(coords, desired, item.checkRunId);
    const checkRunId = result.checkRunId ?? item.checkRunId;
    const outcome = await deps.store.markReported(coords, item.desired, checkRunId);
    if (outcome === 'stale') {
      // A newer desired state landed mid-flight; keep the minted check-run
      // id so its reconciliation updates one run instead of creating another.
      if (result.checkRunId !== undefined && result.checkRunId !== item.checkRunId) {
        await deps.store.recordCheckRunId(coords, result.checkRunId);
      }
      return 'superseded';
    }
    return 'reported';
  } catch (err) {
    const attemptsSoFar = item.backoffAttempts ?? 0;
    const retryAfterSeconds = err instanceof PublishFailure ? err.retryAfterSeconds : undefined;
    const delaySeconds = checkBackoffSeconds(attemptsSoFar, retryAfterSeconds);
    const nextAttemptAt = new Date(nowMs + delaySeconds * 1000).toISOString();
    await deps.store.recordAttemptFailure(coords, attemptsSoFar + 1, nextAttemptAt);
    deps.log('check publish failed; backing off', {
      ...coords,
      attempt: attemptsSoFar + 1,
      nextAttemptAt,
      error: (err as Error).message,
    });
    return 'backed-off';
  }
}

export interface SweepSummary {
  readonly scanned: number;
  readonly dispositions: Record<string, number>;
}

/**
 * The 1-min sweep (spec §13.2): reconcile every unconverged item the stream
 * path did not carry home — crashed batches, expired backoffs, GitHub
 * outages. `reconcileCheck` re-applies every gate, so due items get exactly
 * one call and backing-off items stay untouched.
 */
export async function sweepChecks(deps: ReporterDeps, nowMs: number): Promise<SweepSummary> {
  const items = await deps.store.listUnconverged();
  const dispositions: Record<string, number> = {};
  for (const item of items) {
    const coords = { repo: item.repo, sha: item.sha, context: item.context };
    const disposition = await reconcileCheck(deps, coords, nowMs);
    dispositions[disposition] = (dispositions[disposition] ?? 0) + 1;
  }
  return { scanned: items.length, dispositions };
}
