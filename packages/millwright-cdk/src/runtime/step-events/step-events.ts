import { ValidStepEvent, validateStepEvent } from '@copperbox/millwright-state';

/**
 * Step-events writer core (spec §7.8, C19): project shim-emitted step events
 * into step rows, idempotent on `(run, job, step-index)` — that triple IS the
 * row's key, so duplicate bus deliveries converge on one row instead of
 * multiplying.
 *
 * Step rows are display-plane, never decision-plane: nothing here is read
 * back by the decider, and the honest residual stands — a job can emit step
 * events claiming another job's identity within its own run (the bus policy
 * confines the SOURCE, not the detail). Terminal authority for jobs stays
 * `BatchGetBuilds` (§7.3).
 */

/** The EventBridge payload as the bus rule delivers it. */
export interface StepBusEvent {
  readonly source?: string;
  readonly 'detail-type'?: string;
  readonly detail?: unknown;
}

export interface StepEventsStore {
  /**
   * Upsert the step row for the event's `(run, job, step-index)`. Returns
   * 'superseded' when a terminal row fenced out a late or duplicate RUNNING
   * write; plain duplicates rewrite identical values and report 'written'.
   */
  writeStepRow(event: ValidStepEvent, nowMs: number): Promise<'written' | 'superseded'>;
}

export interface StepEventsDeps {
  readonly store: StepEventsStore;
  readonly log: (message: string, fields?: Record<string, unknown>) => void;
}

export type StepEventDisposition = 'rejected' | 'written' | 'superseded';

/**
 * One event, one row write. Malformed events are logged and dropped —
 * redelivery cannot repair shape, so throwing would only burn retries; store
 * errors propagate so EventBridge's async retry redelivers (safe: the write
 * is idempotent).
 */
export async function processStepEvent(
  deps: StepEventsDeps,
  event: StepBusEvent,
  nowMs: number,
): Promise<StepEventDisposition> {
  const validation = validateStepEvent(
    event.source ?? '',
    event['detail-type'] ?? '',
    event.detail,
  );
  if (!validation.ok) {
    deps.log('step event rejected', { reason: validation.reason, source: event.source });
    return 'rejected';
  }
  return deps.store.writeStepRow(validation.event, nowMs);
}
