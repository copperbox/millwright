import { JobStatus, RunStatus, SkipReason } from './items';
import { RunModelJob, RunModelWorkflow, jobAttemptCap, jobDependencies, runDeadlineMinutes } from './run-model';

/**
 * The pure decider (spec §7.3, C6): `decide(jobModel, states, cancelRequested)
 * → actions`. No I/O and no clock reads — the host (cloud Lambda or local
 * runner) supplies CodeBuild ground truth, table projections, and the time,
 * and applies the returned actions. Every entry is a full re-derivation from
 * current state, which is what makes wakes idempotent: duplicate or stale
 * wakes re-enter here and converge to the same answer.
 *
 * Terminal-state authority: a job with a build is judged ONLY by its build's
 * `BatchGetBuilds` outcome (`buildOutcome`), never by the table projection —
 * a poisoned SUCCEEDED row can never flip a failing sibling green. Table
 * status is consulted only for states the decider itself authors (SKIPPED,
 * CANCELLED/TIMED_OUT without a build) and for rerun-seeded successes, which
 * carry `reusedFrom`.
 */

/** `BatchGetBuilds` ground truth for one build. */
export type BuildOutcome =
  | 'IN_PROGRESS'
  | 'SUCCEEDED'
  | 'FAILED'
  | 'FAULT'
  | 'TIMED_OUT'
  | 'STOPPED';

/**
 * A dispatch claim (attempts incremented, no build recorded yet) older than
 * this is presumed lost to a crash between the claim and `StartBuild`, and
 * becomes retry-eligible — still counted against the attempt cap, so the
 * crash window stays bounded by contract like everything else.
 */
export const STALE_DISPATCH_MS = 5 * 60 * 1000;

/** What the host knows about one job when it asks for a decision. */
export interface DeciderJobState {
  /** StartBuild attempts consumed so far (dispatch claims, not completions). */
  readonly attempts: number;
  /** The current attempt's build, once StartBuild succeeded and was recorded. */
  readonly buildId?: string;
  /**
   * Ground truth for {@link buildId} from `BatchGetBuilds`. The host maps a
   * build the API no longer returns to `FAULT` (retryable): an unverifiable
   * build can never count as a success.
   */
  readonly buildOutcome?: BuildOutcome;
  /** Epoch ms of the last dispatch claim. */
  readonly dispatchedAt?: number;
  /** Table projection — trusted only for decider-authored states. */
  readonly tableStatus?: JobStatus;
  readonly skipReason?: SkipReason;
  /** Run id this job's success was seeded from (`rerun --failed`). */
  readonly reusedFrom?: string;
}

export interface DeciderClock {
  readonly nowMs: number;
  /**
   * Epoch ms of the ORIGINAL run start — the deadline anchor, carried
   * unchanged across carry-over executions (spec §7.3): a fresh execution
   * never resets the wall clock.
   */
  readonly anchorMs: number;
}

export interface JobMark {
  readonly job: string;
  readonly status: JobStatus;
  readonly skipReason?: SkipReason;
}

export interface DeciderActions {
  /** Jobs to StartBuild now (claim → start → record, in the host). */
  readonly dispatch: readonly string[];
  /** In-flight builds to StopBuild (cancellation or deadline). */
  readonly stopBuilds: readonly { readonly job: string; readonly buildId: string }[];
  /** Decider-authored job-state writes (SKIPPED/CANCELLED/TIMED_OUT/FAILED). */
  readonly markJobs: readonly JobMark[];
  /** The run's state once the actions above are applied. */
  readonly runStatus: Extract<RunStatus, 'RUNNING' | 'SUCCEEDED' | 'FAILED' | 'CANCELLED'>;
}

/**
 * A job's effective status, derived from ground truth. Two pseudo-states
 * beyond {@link JobStatus}: `RETRYABLE` (a bounded retry is available —
 * infrastructure FAULT or a stale dispatch claim, attempts under the cap)
 * and `DISPATCHING` (a fresh claim whose StartBuild is presumed in flight).
 */
export type EffectiveJobStatus = JobStatus | 'RETRYABLE' | 'DISPATCHING';

const TERMINAL_JOB_STATUSES: readonly EffectiveJobStatus[] = [
  'SUCCEEDED',
  'FAILED',
  'TIMED_OUT',
  'CANCELLED',
  'SKIPPED',
];

export function effectiveJobStatus(
  job: RunModelJob,
  state: DeciderJobState | undefined,
  nowMs: number,
): EffectiveJobStatus {
  if (!state) {
    return 'PENDING';
  }
  const cap = jobAttemptCap(job);
  if (state.tableStatus === 'SKIPPED') {
    return 'SKIPPED';
  }
  if (state.reusedFrom && state.tableStatus === 'SUCCEEDED') {
    return 'SUCCEEDED';
  }
  if (state.buildId) {
    switch (state.buildOutcome) {
      case 'SUCCEEDED':
        return 'SUCCEEDED';
      case 'FAILED':
        return 'FAILED';
      case 'TIMED_OUT':
        return 'TIMED_OUT';
      case 'STOPPED':
        return 'CANCELLED';
      case 'IN_PROGRESS':
        return 'RUNNING';
      // FAULT (infrastructure failure) and unverifiable builds retry within
      // the cap; command failures (FAILED above) never auto-retry.
      case 'FAULT':
      case undefined:
        return state.attempts < cap ? 'RETRYABLE' : 'FAILED';
    }
  }
  if (state.tableStatus === 'CANCELLED' || state.tableStatus === 'TIMED_OUT') {
    return state.tableStatus;
  }
  if (state.dispatchedAt !== undefined) {
    if (nowMs - state.dispatchedAt <= STALE_DISPATCH_MS) {
      return 'DISPATCHING';
    }
    return state.attempts < cap ? 'RETRYABLE' : 'FAILED';
  }
  return 'PENDING';
}

function isTerminal(status: EffectiveJobStatus): boolean {
  return TERMINAL_JOB_STATUSES.includes(status);
}

/** A dependency blocks its dependents when it terminally did not succeed. */
function blocksDependents(status: EffectiveJobStatus, skipReason?: SkipReason): boolean {
  if (status === 'FAILED' || status === 'TIMED_OUT' || status === 'CANCELLED') {
    return true;
  }
  // A skip_if-guarded skip is success-like (spec §7.5); an upstream_failed
  // skip propagates.
  return status === 'SKIPPED' && skipReason !== 'skip_if';
}

function satisfiesDependents(status: EffectiveJobStatus, skipReason?: SkipReason): boolean {
  return status === 'SUCCEEDED' || (status === 'SKIPPED' && skipReason === 'skip_if');
}

interface Sweep {
  readonly stopBuilds: { job: string; buildId: string }[];
  readonly markJobs: JobMark[];
}

/** Stop every in-flight build and mark every non-settled job `status`. */
function sweepLiveJobs(
  jobs: readonly RunModelJob[],
  states: Readonly<Record<string, DeciderJobState>>,
  nowMs: number,
  status: Extract<JobStatus, 'CANCELLED' | 'TIMED_OUT'>,
): Sweep {
  const stopBuilds: Sweep['stopBuilds'] = [];
  const markJobs: JobMark[] = [];
  for (const job of jobs) {
    const state = states[job.name];
    const effective = effectiveJobStatus(job, state, nowMs);
    if (isTerminal(effective)) {
      continue;
    }
    if (state?.buildId && state.buildOutcome === 'IN_PROGRESS') {
      stopBuilds.push({ job: job.name, buildId: state.buildId });
    }
    markJobs.push({ job: job.name, status });
  }
  return { stopBuilds, markJobs };
}

/**
 * One decision over the whole run. Precedence: cancellation, then the run
 * deadline, then normal DAG progress (skip propagation, bounded retries,
 * dispatch-on-completion, terminal detection).
 */
export function decide(
  workflow: RunModelWorkflow,
  states: Readonly<Record<string, DeciderJobState>>,
  cancelRequested: boolean,
  clock: DeciderClock,
): DeciderActions {
  const jobs = workflow.jobs;

  // Cancellation is decider input, not an outside kill (spec §7.6).
  if (cancelRequested) {
    const sweep = sweepLiveJobs(jobs, states, clock.nowMs, 'CANCELLED');
    return { dispatch: [], ...sweep, runStatus: 'CANCELLED' };
  }

  // Run-level wall-clock deadline, anchored to the original start (§7.3):
  // a stuck run dies a managed death before the history ceiling kills it.
  const deadlineMs = clock.anchorMs + runDeadlineMinutes(workflow) * 60 * 1000;
  if (clock.nowMs >= deadlineMs) {
    const sweep = sweepLiveJobs(jobs, states, clock.nowMs, 'TIMED_OUT');
    return { dispatch: [], ...sweep, runStatus: 'FAILED' };
  }

  const effective = new Map<string, EffectiveJobStatus>();
  const skipReasons = new Map<string, SkipReason | undefined>();
  for (const job of jobs) {
    effective.set(job.name, effectiveJobStatus(job, states[job.name], clock.nowMs));
    skipReasons.set(job.name, states[job.name]?.skipReason);
  }

  // Skip propagation to a fixpoint: transitive dependents of anything that
  // terminally did not succeed become SKIPPED (reason: upstream_failed). An
  // edge to a job the model does not define blocks the same way — fail
  // closed rather than run a job whose dependency can never be judged.
  const markJobs: JobMark[] = [];
  let changed = true;
  while (changed) {
    changed = false;
    for (const job of jobs) {
      const current = effective.get(job.name)!;
      if (current !== 'PENDING' && current !== 'RETRYABLE') {
        continue;
      }
      const blocked = jobDependencies(job).some((dep) => {
        const depStatus = effective.get(dep);
        return depStatus === undefined || blocksDependents(depStatus, skipReasons.get(dep));
      });
      if (blocked) {
        effective.set(job.name, 'SKIPPED');
        skipReasons.set(job.name, 'upstream_failed');
        markJobs.push({ job: job.name, status: 'SKIPPED', skipReason: 'upstream_failed' });
        changed = true;
      }
    }
  }

  // Dispatch-on-completion: every PENDING/RETRYABLE job whose dependencies
  // all succeeded starts now. Exhausted retries surface as FAILED marks so
  // the projection converges with the decision.
  const dispatch: string[] = [];
  for (const job of jobs) {
    const current = effective.get(job.name)!;
    if (current === 'FAILED' && states[job.name]?.tableStatus !== 'FAILED') {
      markJobs.push({ job: job.name, status: 'FAILED' });
    }
    if (current !== 'PENDING' && current !== 'RETRYABLE') {
      continue;
    }
    const ready = jobDependencies(job).every((dep) =>
      satisfiesDependents(effective.get(dep)!, skipReasons.get(dep)),
    );
    if (ready) {
      dispatch.push(job.name);
    }
  }

  if (dispatch.length === 0 && [...effective.values()].every(isTerminal)) {
    const failed = [...effective.entries()].some(
      ([name, status]) =>
        status === 'FAILED' ||
        status === 'TIMED_OUT' ||
        // A CANCELLED job without a run-level cancel is an out-of-band kill.
        status === 'CANCELLED' ||
        (status === 'SKIPPED' && skipReasons.get(name) !== 'skip_if'),
    );
    return { dispatch: [], stopBuilds: [], markJobs, runStatus: failed ? 'FAILED' : 'SUCCEEDED' };
  }

  return { dispatch, stopBuilds: [], markJobs, runStatus: 'RUNNING' };
}
