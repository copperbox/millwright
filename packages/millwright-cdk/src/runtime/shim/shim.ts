import { StepEventDetail, stepEventDetail } from '@copperbox/millwright-state';

/**
 * The step shim's core (spec §7.8, §11.2): wrap one step of one job —
 * start/end/status/skip — emitting step events for the step-events writer
 * (C19) to project into display-plane rows.
 *
 * Two invariants govern every branch:
 *
 * - **Reporting never fails the job.** Step rows are display-plane; an
 *   emitter outage degrades to a stderr warning while the step's own exit
 *   code keeps deciding the build phase.
 * - **`skipIf` skips on success, runs on anything else.** Guard exit 0 →
 *   SKIPPED (`reason: skip_if`), shim exits 0, the job continues. A guard
 *   that fails — or cannot even spawn — falls through to running the step:
 *   running is the safe default for a convenience guard.
 */

/** The job identity the dispatch environment carries into every step. */
export interface StepIdentity {
  /** Canonical run id from `MILLWRIGHT_RUN_ID`. */
  readonly runId: string;
  /** Job name from `MILLWRIGHT_JOB`. */
  readonly job: string;
}

/** One shim-wrapped step, as the rendered buildspec invokes it. */
export interface StepSpec {
  /** Zero-based step index within the job. */
  readonly index: number;
  readonly name?: string;
  /** Guard command: exit 0 means skip the step. */
  readonly skipIf?: string;
  /** The step's shell command. */
  readonly command: string;
}

export interface CommandRunner {
  /** Run a command via the POSIX shell, stdio inherited; resolves to its exit code. */
  run(command: string): Promise<number>;
}

export interface StepEventEmitter {
  emit(detail: StepEventDetail): Promise<void>;
}

export interface ShimDeps {
  readonly runner: CommandRunner;
  readonly emitter: StepEventEmitter;
  readonly clock: () => number;
  readonly warn: (message: string) => void;
}

/** Exit code when the step command itself could not be spawned. */
const SPAWN_FAILURE_EXIT_CODE = 127;

function isoAt(nowMs: number): string {
  return new Date(nowMs).toISOString();
}

async function emitSafely(deps: ShimDeps, detail: StepEventDetail): Promise<void> {
  try {
    await deps.emitter.emit(stepEventDetail(detail));
  } catch (err) {
    deps.warn(`millwright-shim: step event not reported: ${(err as Error).message}`);
  }
}

/**
 * Wrap one step: evaluate `skipIf`, report start/end/status, propagate the
 * step's exit code as the shim's own.
 */
export async function runStep(
  deps: ShimDeps,
  identity: StepIdentity,
  spec: StepSpec,
): Promise<number> {
  const base = {
    runId: identity.runId,
    job: identity.job,
    stepIndex: spec.index,
    name: spec.name,
  };
  const startedAt = isoAt(deps.clock());

  if (spec.skipIf !== undefined) {
    let guardExit: number | undefined;
    try {
      guardExit = await deps.runner.run(spec.skipIf);
    } catch (err) {
      deps.warn(
        `millwright-shim: skipIf guard could not run (${(err as Error).message}); ` +
          'running the step',
      );
    }
    if (guardExit === 0) {
      await emitSafely(deps, {
        ...base,
        status: 'SKIPPED',
        reason: 'skip_if',
        startedAt,
        finishedAt: isoAt(deps.clock()),
      });
      return 0;
    }
  }

  await emitSafely(deps, { ...base, status: 'RUNNING', startedAt });

  let exitCode: number;
  try {
    exitCode = await deps.runner.run(spec.command);
  } catch (err) {
    deps.warn(`millwright-shim: step command could not run: ${(err as Error).message}`);
    exitCode = SPAWN_FAILURE_EXIT_CODE;
  }

  await emitSafely(deps, {
    ...base,
    status: exitCode === 0 ? 'SUCCEEDED' : 'FAILED',
    startedAt,
    finishedAt: isoAt(deps.clock()),
  });
  return exitCode;
}
