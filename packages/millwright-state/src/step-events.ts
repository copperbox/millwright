import { STEP_EVENT_SOURCE } from './bus-events';
import { SkipReason, StepStatus } from './items';
import { KeyFormatError, MAX_STEP_INDEX, RunCoordinates, parseRunId } from './keys';

/**
 * The step-event contract between the step shim and the step-events writer
 * (spec §7.8, C19). The shim wraps every step and emits these events via
 * `events:PutEvents` under `source: millwright.step` — the only source the
 * bus policy lets a job role use — and C19 projects them into step rows.
 *
 * Honest residual, stated (spec §7.8): the job role's grant confines the
 * SOURCE, not the detail, so a job can emit step events claiming another
 * job's identity within its own run. Step rows are therefore display-plane,
 * never decision-plane — terminal authority stays `BatchGetBuilds`.
 */

/** The EventBridge detail-type every step event carries. */
export const STEP_EVENT_DETAIL_TYPE = 'step';

/**
 * Cloud sink: the deployment bus name, set on every dispatched build (and
 * exported for the CLI's cloud-side plumbing). The shim PutEvents here.
 */
export const EVENT_BUS_ENV = 'MILLWRIGHT_EVENT_BUS';

/**
 * Local sink override: a file path the shim appends JSON-lines step events
 * to instead of calling EventBridge. Set by the local runner next to its
 * shim bind-mount; takes precedence over {@link EVENT_BUS_ENV}.
 */
export const STEP_EVENTS_FILE_ENV = 'MILLWRIGHT_STEP_EVENTS_FILE';

/** Why a step was SKIPPED — only its own `skipIf` guard ever skips a step. */
export type StepSkipReason = Extract<SkipReason, 'skip_if'>;

/** The EventBridge `detail` payload of one step event, as the shim emits it. */
export interface StepEventDetail {
  /** Canonical run id, `<repo>#<workflow>#<number>` (`MILLWRIGHT_RUN_ID`). */
  readonly runId: string;
  readonly job: string;
  /** Zero-based step index within the job. */
  readonly stepIndex: number;
  readonly status: StepStatus;
  readonly name?: string;
  /** Present only on SKIPPED, and only ever `skip_if`. */
  readonly reason?: StepSkipReason;
  readonly startedAt?: string;
  readonly finishedAt?: string;
}

/** A step event that passed source/shape validation, run identity parsed. */
export interface ValidStepEvent {
  readonly coords: RunCoordinates;
  readonly job: string;
  readonly stepIndex: number;
  readonly status: StepStatus;
  readonly name?: string;
  readonly reason?: StepSkipReason;
  readonly startedAt?: string;
  readonly finishedAt?: string;
}

export type StepEventValidation =
  | { readonly ok: true; readonly event: ValidStepEvent }
  | { readonly ok: false; readonly reason: string };

const STEP_STATUSES: readonly StepStatus[] = ['RUNNING', 'SUCCEEDED', 'FAILED', 'SKIPPED'];

const TIMESTAMP_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,3})?Z$/;

function reject(reason: string): StepEventValidation {
  return { ok: false, reason };
}

/**
 * Static source/shape validation for `millwright.step` events, mirroring the
 * launcher's `validateBusEvent`: pure, no I/O, run before any write so a
 * malformed event is dropped instead of poisoning a row. Returns the event
 * with its run identity parsed, or a rejection reason.
 */
export function validateStepEvent(
  source: string,
  detailType: string,
  detail: unknown,
): StepEventValidation {
  if (source !== STEP_EVENT_SOURCE) {
    return reject(`step events are only accepted from "${STEP_EVENT_SOURCE}", got "${source}"`);
  }
  if (detailType !== STEP_EVENT_DETAIL_TYPE) {
    return reject(`unknown detail-type "${detailType}"`);
  }
  if (typeof detail !== 'object' || detail === null || Array.isArray(detail)) {
    return reject('detail must be a JSON object');
  }
  const d = detail as Record<string, unknown>;

  if (typeof d.runId !== 'string') {
    return reject('runId must be a string');
  }
  let coords: RunCoordinates;
  try {
    coords = parseRunId(d.runId);
  } catch (err) {
    if (err instanceof KeyFormatError) {
      return reject(err.message);
    }
    throw err;
  }
  if (typeof d.job !== 'string' || !d.job || d.job.includes('#')) {
    return reject(`job must be a non-empty name free of "#", got ${JSON.stringify(d.job)}`);
  }
  if (
    typeof d.stepIndex !== 'number' ||
    !Number.isInteger(d.stepIndex) ||
    d.stepIndex < 0 ||
    d.stepIndex > MAX_STEP_INDEX
  ) {
    return reject(`stepIndex must be an integer in [0, ${MAX_STEP_INDEX}]`);
  }
  if (typeof d.status !== 'string' || !(STEP_STATUSES as readonly string[]).includes(d.status)) {
    return reject(`unknown step status ${JSON.stringify(d.status)}`);
  }
  const status = d.status as StepStatus;
  if (d.reason !== undefined) {
    if (d.reason !== 'skip_if') {
      return reject(`unknown step skip reason ${JSON.stringify(d.reason)}`);
    }
    if (status !== 'SKIPPED') {
      return reject('reason is only valid on SKIPPED steps');
    }
  }
  if (d.name !== undefined && typeof d.name !== 'string') {
    return reject('name must be a string');
  }
  for (const field of ['startedAt', 'finishedAt'] as const) {
    const value = d[field];
    if (value !== undefined && (typeof value !== 'string' || !TIMESTAMP_PATTERN.test(value))) {
      return reject(`${field} must be an ISO-8601 UTC timestamp`);
    }
  }

  return {
    ok: true,
    event: {
      coords,
      job: d.job,
      stepIndex: d.stepIndex,
      status,
      name: d.name as string | undefined,
      reason: d.reason as StepSkipReason | undefined,
      startedAt: d.startedAt as string | undefined,
      finishedAt: d.finishedAt as string | undefined,
    },
  };
}

/**
 * Emit-side constructor: a detail payload guaranteed to pass
 * {@link validateStepEvent}, with undefined optionals dropped so the wire
 * payload never carries explicit nulls. Throws on anything the writer would
 * reject — an emitter bug should fail the emitter, not silently drop rows.
 */
export function stepEventDetail(detail: StepEventDetail): StepEventDetail {
  const compact = Object.fromEntries(
    Object.entries(detail).filter(([, value]) => value !== undefined),
  ) as unknown as StepEventDetail;
  const result = validateStepEvent(STEP_EVENT_SOURCE, STEP_EVENT_DETAIL_TYPE, compact);
  if (!result.ok) {
    throw new Error(`Invalid step event: ${result.reason}`);
  }
  return compact;
}
