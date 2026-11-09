import {
  RunCoordinates,
  RunItem,
  TERMINAL_RUN_STATUSES,
  desiredSynthFailed,
  formatRunId,
  parseRunId,
  synthCheckContext,
} from '@copperbox/millwright-state';
import { DesiredCheckWrite } from '../shared/checks';
import { parseExecutionInput } from '../shared/execution-input';
import {
  GroupReleaseOutcome,
  GroupSlotStore,
  PendingRunStarter,
  releaseGroupSlot,
} from '../shared/groups';

/**
 * The synth-failure step (issue #50): the run executor's synth phase caught
 * an error — the synth build failed, timed out, or post-synth rejected the
 * model — and the execution is about to end in `SynthFailed`. Nothing on
 * that path ever reached the decider loop, which is the only place a run
 * row normally moves to a terminal state and its concurrency-group slot is
 * released. Left alone, the run reads PENDING forever and every later run
 * in its group waits behind it.
 *
 * This step does the decider's exit work for a run that never started:
 *
 * 1. mark the run FAILED with `finishedAt` — the same conditional terminal
 *    transition `finishRun` uses, so a run cancelled meanwhile stays
 *    CANCELLED;
 * 2. release its group slot through the shared convergence, starting and
 *    promoting a queued waiter (spec §8.4);
 * 3. record the failure in the workflow's synth check so GitHub shows why.
 *
 * Only the run-row write may throw: a failed update means the run is still
 * live and the machine should retry this step. The release and the check
 * write are best-effort — the sweep repairs a slot held by a terminal run,
 * and a missing check never justifies hiding the real synth error.
 *
 * Bootstrap (`synth-only`) executions have no run row and skip through.
 */

/** A Step Functions Catch error output, `{ Error, Cause }`. */
export interface CaughtError {
  readonly Error?: string;
  readonly Cause?: string;
}

export interface SynthFailureEvent {
  /** The state machine's `$` — the launcher-authored execution input. */
  readonly input: unknown;
  /** The caught synth or post-synth error (`$.synthError`). */
  readonly synthError?: CaughtError;
}

export interface SynthFailureStore extends GroupSlotStore {
  /** The shared conditional terminal transition; false when already terminal. */
  finishRun(coords: RunCoordinates, status: RunItem['status'], nowMs: number): Promise<boolean>;
  /** The §13.2 ownership upsert; false when a newer run owns the context. */
  putDesiredCheck(write: DesiredCheckWrite, nowMs: number): Promise<boolean>;
}

export interface SynthFailureDeps {
  readonly store: SynthFailureStore;
  /** Starts a group's pending run on hand-off (`states:StartExecution`). */
  readonly starter: PendingRunStarter;
  readonly log: (message: string, fields?: Record<string, unknown>) => void;
}

export type SynthFailureResult =
  | { readonly outcome: 'skipped' }
  | {
      readonly outcome: 'failed' | 'already-terminal';
      readonly runId: string;
      readonly group: GroupReleaseOutcome | 'none' | 'error';
    };

const GENERIC_SYNTH_FAILURE = 'The synth job or post-synth validation failed';

/**
 * The operator-facing reason. The synth-events completer sends display text
 * as the cause; a Lambda throw (post-synth) arrives as a JSON envelope whose
 * `errorMessage` is the useful part; a phase timeout has only an error name.
 */
export function synthFailureMessage(error: CaughtError | undefined): string {
  const cause = error?.Cause?.trim();
  if (cause) {
    try {
      const parsed = JSON.parse(cause) as { errorMessage?: unknown };
      if (typeof parsed?.errorMessage === 'string' && parsed.errorMessage.length > 0) {
        return parsed.errorMessage;
      }
    } catch {
      // Not a Lambda error envelope; the cause is the message.
    }
    return cause;
  }
  return error?.Error?.trim() || GENERIC_SYNTH_FAILURE;
}

export async function recordSynthFailure(
  deps: SynthFailureDeps,
  event: SynthFailureEvent,
  nowMs: number,
): Promise<SynthFailureResult> {
  const { store, log } = deps;
  const input = parseExecutionInput(event.input);
  if (input.action !== 'run') {
    log('synth-only execution failed; no run row to close', { repo: input.repo, sha: input.sha });
    return { outcome: 'skipped' };
  }
  const coords = parseRunId(input.runId);
  const runId = formatRunId(coords);
  const message = synthFailureMessage(event.synthError);

  // Terminal first — may throw, and should: the machine retries the step.
  const finished = await store.finishRun(coords, 'FAILED', nowMs);
  log(finished ? 'run failed at synth' : 'run already terminal at synth failure', {
    runId,
    error: message,
  });

  const run = await store.getRun(coords);
  if (run && !TERMINAL_RUN_STATUSES.includes(run.status)) {
    // Only reachable if the conditional write was lost to a concurrent
    // resurrection, which the protocol forbids; worth a loud log.
    log('run row still live after the synth-failure write', { runId, status: run.status });
  }

  const group = await releaseGroup(deps, run, runId, nowMs);

  try {
    await store.putDesiredCheck(
      {
        repo: coords.repo,
        sha: input.sha,
        context: synthCheckContext(coords.workflow),
        ownerRun: `${coords.workflow}#${coords.runNumber}`,
        ownerRunNumber: coords.runNumber,
        desired: desiredSynthFailed(`${coords.workflow}#${coords.runNumber}`, message),
      },
      nowMs,
    );
  } catch (err) {
    log('could not record the synth check failure', { runId, error: (err as Error).message });
  }

  return { outcome: finished ? 'failed' : 'already-terminal', runId, group };
}

/**
 * Release the run's concurrency-group slot and start the pending run (spec
 * §8.4). Never throws: a hand-off left incomplete here is re-converged by the
 * sweep within a minute, now that the run row reads terminal.
 */
async function releaseGroup(
  deps: SynthFailureDeps,
  run: RunItem | undefined,
  runId: string,
  nowMs: number,
): Promise<GroupReleaseOutcome | 'none' | 'error'> {
  const group = run?.concurrencyGroup;
  if (!group) {
    return 'none';
  }
  try {
    const outcome = await releaseGroupSlot(deps, group, runId, nowMs);
    if (outcome !== 'not-held') {
      deps.log('released concurrency-group slot', { group, runId, outcome });
    }
    return outcome;
  } catch (err) {
    deps.log('group release failed; the sweep will repair', {
      group,
      runId,
      error: (err as Error).message,
    });
    return 'error';
  }
}
