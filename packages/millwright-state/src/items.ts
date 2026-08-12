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
  /** e.g. `superseded` on concurrency-policy cancellation. */
  readonly reason?: string;
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
  readonly startedAt?: string;
  readonly finishedAt?: string;
}

/**
 * `EVENT#<repo>#<ref>#<sha>#<kind>` / `-` — conditional-put dedupe record,
 * TTL 30 min. Doubles as the processing record: the run id is written on
 * creation so launcher retries resume idempotently.
 */
export interface EventDedupeItem extends ExpiringItem {
  readonly runId?: string;
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

/**
 * `CHECK#<repo>#<sha>` / `CTX#<context>` — reporter reconciliation state.
 * Deciders upsert the desired side (conditional on the §13.2 ownership rule:
 * the newest run owns the context); the reporter alone writes the reported
 * side. Convergence is `reported === desired` on the canonical serialization.
 */
export interface CheckStateItem extends ExpiringItem {
  readonly repo: string;
  readonly sha: string;
  readonly context: string;
  /** What the check should show (decider-written, serialized `DesiredCheckState`). */
  readonly desired?: string;
  /** When `desired` was last written; anchors the 7-day abandonment clock. */
  readonly desiredAt?: string;
  /** What GitHub last acknowledged (reporter-written). */
  readonly reported?: string;
  readonly checkRunId?: number;
  /** Run id that owns this context on this sha (§13.2 ownership rule). */
  readonly ownerRun?: string;
  /** Owner's run number — the conditional-write comparand for `ownerRun`. */
  readonly ownerRunNumber?: number;
  readonly backoffAttempts?: number;
  readonly nextAttemptAt?: string;
  /** Set when reconciliation gave up; surfaced by `doctor`, never retried. */
  readonly abandoned?: boolean;
}
