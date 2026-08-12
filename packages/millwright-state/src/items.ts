import { TriggerKind } from './keys';

/**
 * Typed attribute shapes for every state-table row (spec §9.1), as stored via
 * the document mapper. Keys (`pk`/`sk`) are built and parsed by `keys.ts`;
 * `expiresAt` is stamped by `ttl.ts` (absent on TTL-exempt `REG#` rows).
 *
 * Timestamps are ISO-8601 UTC strings except `expiresAt`, which DynamoDB TTL
 * requires to be epoch seconds.
 *
 * The state table is never a credential store: no item shape may carry
 * tokens, keys, or secret material of any kind.
 */

export type RunStatus = 'PENDING' | 'QUEUED' | 'RUNNING' | 'SUCCEEDED' | 'FAILED' | 'CANCELLED';

/** Run statuses with no further transitions — the only rerun-able sources. */
export const TERMINAL_RUN_STATUSES: readonly RunStatus[] = ['SUCCEEDED', 'FAILED', 'CANCELLED'];

export type JobStatus =
  | 'PENDING'
  | 'QUEUED'
  | 'PROVISIONING'
  | 'RUNNING'
  | 'SUCCEEDED'
  | 'FAILED'
  | 'TIMED_OUT'
  | 'CANCELLED'
  | 'SKIPPED';

/**
 * Job statuses `rerun --failed` re-executes (spec §7.7). Their SKIPPED
 * dependents rerun with them; SUCCEEDED jobs' outputs are reused instead.
 */
export const RERUNNABLE_JOB_STATUSES: readonly JobStatus[] = ['FAILED', 'TIMED_OUT', 'CANCELLED'];

export type StepStatus = 'RUNNING' | 'SUCCEEDED' | 'FAILED' | 'SKIPPED';

/** Why a job was SKIPPED: a failed upstream vs its own `skipIf` guard. */
export type SkipReason = 'upstream_failed' | 'skip_if';

interface KeyedItem {
  readonly pk: string;
  readonly sk: string;
}

interface ExpiringItem extends KeyedItem {
  /** DynamoDB TTL, epoch seconds. */
  readonly expiresAt: number;
}

/** `WF#<repo>#<workflow>` / `COUNTER` — atomically incremented by the launcher. */
export interface RunCounterItem extends ExpiringItem {
  readonly value: number;
}

/** `WF#<repo>#<workflow>` / `RUN#<inverted zero-padded number>` */
export interface RunItem extends ExpiringItem {
  readonly repo: string;
  readonly workflow: string;
  readonly runNumber: number;
  readonly status: RunStatus;
  readonly trigger: TriggerKind;
  readonly ref: string;
  readonly sha: string;
  readonly createdAt: string;
  readonly startedAt?: string;
  readonly finishedAt?: string;
  /**
   * Deadline anchor: the FIRST execution's start, carried unchanged across
   * carry-over re-executions so the run-level wall clock never resets.
   */
  readonly originalStartedAt: string;
  readonly cancelRequested?: boolean;
  /** Run id this run is a rerun of. */
  readonly rerunOf?: string;
  /**
   * `rerun --failed`: jobs whose succeeded outputs were prefix-copied from
   * {@link rerunOf} — the decider seeds them terminal SUCCEEDED with
   * `reusedFrom` instead of dispatching them.
   */
  readonly reuseJobs?: readonly string[];
  /** e.g. `superseded` on concurrency-policy cancellation. */
  readonly reason?: string;
  /**
   * Evaluated concurrency-group key this run gates through (spec §8.4),
   * stamped at creation when the matched workflow declares a group — the
   * decider and sweep release exactly this slot on completion. Absent =
   * unlimited concurrency.
   */
  readonly concurrencyGroup?: string;
  /** Typed inputs carried by a `dispatch` trigger. */
  readonly inputs?: Readonly<Record<string, string | boolean>>;
  /** Current Step Functions task token; rewritten every decider iteration. */
  readonly taskToken?: string;
}

/**
 * `RUN#<repo>#<workflow>#<number>` / `JOB#<name>` — a projection of CodeBuild
 * state, display-plane convenience only: `BatchGetBuilds` stays authoritative
 * for terminal states.
 */
export interface JobItem extends ExpiringItem {
  readonly repo: string;
  readonly workflow: string;
  readonly runNumber: number;
  readonly job: string;
  readonly status: JobStatus;
  /** Total StartBuild attempts consumed (dispatch claims; spec §7.3 cap). */
  readonly attempts?: number;
  /** ISO timestamp of the latest dispatch claim. */
  readonly dispatchedAt?: string;
  readonly buildId?: string;
  readonly buildArn?: string;
  readonly logStreamName?: string;
  readonly startedAt?: string;
  readonly finishedAt?: string;
  /** Run id whose succeeded output this job was seeded from (`rerun --failed`). */
  readonly reusedFrom?: string;
  readonly skipReason?: SkipReason;
}

/** `RUN#…` / `JOB#<name>#STEP#<index>` — written by C19; display-plane only. */
export interface StepItem extends ExpiringItem {
  readonly repo: string;
  readonly workflow: string;
  readonly runNumber: number;
  readonly job: string;
  readonly stepIndex: number;
  readonly status: StepStatus;
  readonly name?: string;
  /** Present only on SKIPPED — a step only ever skips via its own `skipIf`. */
  readonly reason?: Extract<SkipReason, 'skip_if'>;
  readonly startedAt?: string;
  readonly finishedAt?: string;
}

/**
 * `EVENT#<repo>#<ref>#<sha>#<kind>[#<qualifier>]` / `-` — conditional-put
 * dedupe record, TTL 30 min. A processing record, not a tombstone: each
 * matched workflow's run id is written under `runIds` as its run is created,
 * so a launcher crash-and-redeliver resumes idempotently instead of dropping
 * the event. The launcher writes `runIds: {}` at claim time so later
 * per-workflow SETs can target map paths unconditionally.
 */
export interface EventDedupeItem extends ExpiringItem {
  /** Workflow name → run id, written transactionally with each run's creation. */
  readonly runIds?: Readonly<Record<string, string>>;
}

/** `BUILD#<build-id>` / `-` — run/job identity for the build-events handler. */
export interface BuildMappingItem extends KeyedItem {
  readonly repo: string;
  readonly workflow: string;
  readonly runNumber: number;
  readonly job: string;
  /** Stamped short past build terminality, not at creation. */
  readonly expiresAt?: number;
}

/** `GROUP#<key>` / `-` — mutated only by conditional/transactional writes. */
export interface ConcurrencyGroupItem extends KeyedItem {
  /** Run id currently holding the group's single execution slot. */
  readonly running?: string;
  /** Run id in the pending slot of one. */
  readonly pending?: string;
  readonly expiresAt?: number;
}

/** Per-workflow registry payload: what the launcher matches events against. */
export interface RegistryWorkflowEntry {
  /** Trigger map as validated from the synthed model. */
  readonly triggers: unknown;
  readonly concurrency?: {
    readonly group: string;
    readonly policy: 'queue' | 'supersede';
  };
}

/**
 * `REG#<repo>` / `REF#<ref>` — configuration index written by control-plane
 * code post-validation. TTL-exempt: never carries `expiresAt`.
 */
export interface RegistryItem extends KeyedItem {
  readonly repo: string;
  readonly ref: string;
  readonly schemaVersion: number;
  readonly workflows: Readonly<Record<string, RegistryWorkflowEntry>>;
  readonly expiresAt?: never;
}

/** `CHECK#<repo>#<sha>` / `CTX#<context>` — reporter reconciliation state. */
export interface CheckStateItem extends ExpiringItem {
  readonly repo: string;
  readonly sha: string;
  readonly context: string;
  /** What the check should show (decider-written desired state). */
  readonly desired?: string;
  /** What GitHub last acknowledged (reporter-written). */
  readonly reported?: string;
  readonly checkRunId?: number;
  /** Run id that owns this context on this sha (§13.2 ownership rule). */
  readonly ownerRun?: string;
  readonly backoffAttempts?: number;
  readonly nextAttemptAt?: string;
  /** Set when reconciliation gave up; surfaced by `doctor`, never retried. */
  readonly abandoned?: boolean;
}
