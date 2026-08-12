import { createHash } from 'node:crypto';
import {
  BuildOutcome,
  DeciderJobState,
  JobItem,
  JobStatus,
  RunCoordinates,
  RunItem,
  RunModel,
  RunModelJob,
  RunModelWorkflow,
  decide,
  formatRunId,
  parseRunId,
  workflowFromModel,
} from '@copperbox/millwright-state';
import { JobProjectionPatch } from '../shared/jobs';

/**
 * One decider iteration (spec §7.3, C6): the Lambda host around the pure
 * `decide` library. Invoked by the run executor's token-wait state WITH the
 * iteration's task token; the host writes that token onto the Run item
 * before doing anything wake-relevant, so senders (build-events handler,
 * CLI cancel) always find the freshest token. The state then parks until a
 * wake or its 60 s timeout — when the run must transition immediately
 * (terminal, carry-over) the host completes its OWN token instead.
 *
 * Everything here is a re-derivation from current state — Run item,
 * job rows, CodeBuild ground truth — which is what makes duplicate, stale
 * and concurrent wakes safe: a lost dispatch race skips quietly, a stale
 * token send is swallowed, and re-entry converges on the same answer.
 */

export interface DeciderTaskInput {
  readonly taskToken: string;
  readonly runId: string;
  /** The executing loop's iteration counter, bumped by the state machine. */
  readonly iteration: number;
  /** Current execution's name — the carry-over name derives from it. */
  readonly executionName: string;
}

/** What `BatchGetBuilds` reported for one build. */
export interface BuildSnapshot {
  readonly outcome: BuildOutcome;
  readonly phase?: string;
  readonly logStreamName?: string;
  readonly startedAt?: string;
  readonly finishedAt?: string;
}

export interface DispatchContext {
  readonly coords: RunCoordinates;
  readonly runId: string;
  readonly sha: string;
  readonly ref: string;
}

export interface DeciderStore {
  getRun(coords: RunCoordinates): Promise<RunItem | undefined>;
  /**
   * Write the iteration's task token; on `markStarted`, also stamp
   * startedAt/originalStartedAt (the deadline anchor) and flip the run
   * RUNNING. Returns 'terminal' (nothing written) when the run is already
   * finished — a race with another iteration.
   */
  beginIteration(
    coords: RunCoordinates,
    taskToken: string,
    opts: { readonly markStarted: boolean },
    nowMs: number,
  ): Promise<'ok' | 'terminal'>;
  listJobs(coords: RunCoordinates): Promise<readonly JobItem[]>;
  /**
   * Claim a dispatch: attempts := expected + 1, conditioned on the row still
   * showing exactly `expected` attempts, so concurrent iterations can never
   * double-start one attempt. False = another iteration won.
   */
  claimDispatch(
    coords: RunCoordinates,
    job: string,
    expectedAttempts: number,
    nowMs: number,
  ): Promise<boolean>;
  /** Record the started build on the claim + write the `BUILD#` mapping item. */
  recordDispatch(
    coords: RunCoordinates,
    job: string,
    attempts: number,
    buildId: string,
    buildArn: string | undefined,
    nowMs: number,
  ): Promise<void>;
  writeJobProjection(
    coords: RunCoordinates,
    job: string,
    patch: JobProjectionPatch,
    nowMs: number,
  ): Promise<void>;
  /** Mark the run terminal and clear its token; a no-op if already terminal. */
  finishRun(coords: RunCoordinates, status: RunItem['status'], nowMs: number): Promise<void>;
}

export interface BuildRunner {
  start(job: RunModelJob, ctx: DispatchContext): Promise<{ buildId: string; buildArn?: string }>;
  stop(buildId: string): Promise<void>;
  /** Ground truth; builds the API does not return are simply absent. */
  getStatuses(buildIds: readonly string[]): Promise<ReadonlyMap<string, BuildSnapshot>>;
}

export interface ModelSource {
  /** The run's validated model, cached in-process across iterations. */
  load(coords: RunCoordinates): Promise<RunModel>;
}

export interface TokenSender {
  /** SendTaskSuccess; stale-token errors are swallowed (wakes converge later). */
  success(taskToken: string, output: unknown): Promise<void>;
  failure(taskToken: string, error: string, cause: string): Promise<void>;
}

export interface DeciderDeps {
  readonly store: DeciderStore;
  readonly runner: BuildRunner;
  readonly models: ModelSource;
  readonly sender: TokenSender;
  /** Iterations per execution before carrying over to a fresh one. */
  readonly iterationBudget: number;
  readonly log: (message: string, fields?: Record<string, unknown>) => void;
}

export type IterationOutcome = 'parked' | 'terminal' | 'carry-over' | 'failed';

const TERMINAL_RUN_STATUSES: readonly RunItem['status'][] = ['SUCCEEDED', 'FAILED', 'CANCELLED'];

/** The decider's SendTaskSuccess payloads — what the state machine routes on. */
export type DeciderOutput =
  | { readonly outcome: 'terminal'; readonly runStatus: RunItem['status'] }
  | {
      readonly outcome: 'carry-over';
      readonly carryOver: { readonly name: string; readonly input: CarryOverInput };
    };

export interface CarryOverInput {
  readonly action: 'run';
  /** Skips straight to the decider loop — synth already happened. */
  readonly resume: true;
  readonly runId: string;
  readonly repo: string;
  readonly workflow: string;
  readonly runNumber: number;
}

/**
 * Deterministic, chainable carry-over execution name: each generation hashes
 * its predecessor's name, so retries within one execution reuse the same
 * name (idempotent under ExecutionAlreadyExists) while successive
 * generations never collide.
 */
export function carryOverExecutionName(currentExecutionName: string): string {
  return `co-${createHash('sha256').update(currentExecutionName).digest('hex').slice(0, 40)}`;
}

/** Display projection for a build snapshot; FAULTs are left to the decider. */
export function projectionStatus(snapshot: BuildSnapshot): JobStatus | undefined {
  switch (snapshot.outcome) {
    case 'IN_PROGRESS':
      if (snapshot.phase === 'SUBMITTED' || snapshot.phase === 'QUEUED') {
        return 'QUEUED';
      }
      return snapshot.phase === 'PROVISIONING' ? 'PROVISIONING' : 'RUNNING';
    case 'SUCCEEDED':
      return 'SUCCEEDED';
    case 'FAILED':
      return 'FAILED';
    case 'TIMED_OUT':
      return 'TIMED_OUT';
    case 'STOPPED':
      return 'CANCELLED';
    case 'FAULT':
      return undefined;
  }
}

export async function runDeciderIteration(
  deps: DeciderDeps,
  input: DeciderTaskInput,
  nowMs: number,
): Promise<IterationOutcome> {
  const { store, runner, models, sender, log } = deps;
  const coords = parseRunId(input.runId);
  const nowIso = new Date(nowMs).toISOString();

  const run = await store.getRun(coords);
  if (!run) {
    await sender.failure(input.taskToken, 'RunNotFound', `No run record for ${input.runId}`);
    return 'failed';
  }
  if (TERMINAL_RUN_STATUSES.includes(run.status)) {
    await sender.success(input.taskToken, terminal(run.status));
    return 'terminal';
  }

  // Token first: from here on, any completion event can wake this iteration.
  // First entry also stamps the deadline anchor — the original run start,
  // which carry-over executions read back and never reset (spec §7.3).
  const markStarted = !run.startedAt;
  if ((await store.beginIteration(coords, input.taskToken, { markStarted }, nowMs)) === 'terminal') {
    const finished = await store.getRun(coords);
    await sender.success(input.taskToken, terminal(finished?.status ?? 'FAILED'));
    return 'terminal';
  }
  const anchorMs = markStarted ? nowMs : Date.parse(run.originalStartedAt ?? run.startedAt!);

  let jobsModel: RunModelWorkflow;
  try {
    jobsModel = workflowFromModel(await models.load(coords), coords.workflow);
  } catch (err) {
    // The synth step wrote and validated the model before the loop began; a
    // missing or uninterpretable one is a fault the loop can only report.
    await sender.failure(input.taskToken, 'ModelUnavailable', (err as Error).message);
    return 'failed';
  }

  const rows = await store.listJobs(coords);
  const rowByName = new Map(rows.map((row) => [row.job, row]));
  const buildIds = rows.flatMap((row) => (row.buildId ? [row.buildId] : []));
  const snapshots = await runner.getStatuses(buildIds);

  // Converge job-row projections toward ground truth before deciding.
  for (const row of rows) {
    if (!row.buildId) {
      continue;
    }
    const snapshot = snapshots.get(row.buildId);
    const projected = snapshot && projectionStatus(snapshot);
    if (!projected) {
      continue;
    }
    if (projected !== row.status || (snapshot.logStreamName && !row.logStreamName)) {
      await store.writeJobProjection(
        coords,
        row.job,
        {
          status: projected,
          logStreamName: snapshot.logStreamName,
          startedAt: snapshot.startedAt,
          finishedAt: snapshot.finishedAt,
          ifBuildId: row.buildId,
        },
        nowMs,
      );
    }
  }

  const states: Record<string, DeciderJobState> = {};
  for (const job of jobsModel.jobs) {
    const row = rowByName.get(job.name);
    if (!row) {
      continue;
    }
    states[job.name] = {
      attempts: row.attempts ?? 0,
      buildId: row.buildId,
      // A build BatchGetBuilds cannot verify is a retryable FAULT: an
      // unverifiable build never counts as success.
      buildOutcome: row.buildId ? (snapshots.get(row.buildId)?.outcome ?? 'FAULT') : undefined,
      dispatchedAt: row.dispatchedAt ? Date.parse(row.dispatchedAt) : undefined,
      tableStatus: row.status,
      skipReason: row.skipReason,
      reusedFrom: row.reusedFrom,
    };
  }

  const actions = decide(jobsModel, states, run.cancelRequested === true, { nowMs, anchorMs });

  for (const stop of actions.stopBuilds) {
    try {
      await runner.stop(stop.buildId);
    } catch (err) {
      // The build may already be over; ground truth reconciles either way.
      log('StopBuild failed', { buildId: stop.buildId, error: (err as Error).message });
    }
  }

  for (const mark of actions.markJobs) {
    await store.writeJobProjection(
      coords,
      mark.job,
      { status: mark.status, skipReason: mark.skipReason, finishedAt: nowIso },
      nowMs,
    );
  }

  for (const jobName of actions.dispatch) {
    const job = jobsModel.jobs.find((candidate) => candidate.name === jobName)!;
    const expected = states[jobName]?.attempts ?? 0;
    if (!(await store.claimDispatch(coords, jobName, expected, nowMs))) {
      log('lost dispatch claim to a concurrent iteration', { job: jobName });
      continue;
    }
    try {
      const { buildId, buildArn } = await runner.start(job, {
        coords,
        runId: input.runId,
        sha: run.sha,
        ref: run.ref,
      });
      await store.recordDispatch(coords, jobName, expected + 1, buildId, buildArn, nowMs);
    } catch (err) {
      // The claim stands; once stale it becomes retry-eligible within the
      // attempt cap, so a failed StartBuild stays bounded by contract.
      log('dispatch failed; the stale claim will retry within the cap', {
        job: jobName,
        error: (err as Error).message,
      });
    }
  }

  if (actions.runStatus !== 'RUNNING') {
    await store.finishRun(coords, actions.runStatus, nowMs);
    await sender.success(input.taskToken, terminal(actions.runStatus));
    log('run finished', { runId: formatRunId(coords), status: actions.runStatus });
    return 'terminal';
  }

  if (input.iteration >= deps.iterationBudget) {
    // Approaching the 25,000-event history ceiling: hand the loop to a fresh
    // execution of the same machine, resuming from table state.
    const output: DeciderOutput = {
      outcome: 'carry-over',
      carryOver: {
        name: carryOverExecutionName(input.executionName),
        input: {
          action: 'run',
          resume: true,
          runId: input.runId,
          repo: coords.repo,
          workflow: coords.workflow,
          runNumber: coords.runNumber,
        },
      },
    };
    await sender.success(input.taskToken, output);
    log('carrying over to a fresh execution', { runId: input.runId, iteration: input.iteration });
    return 'carry-over';
  }

  // Park on the token: the build-events handler is the low-latency wake, the
  // state's 60 s timeout the safety net. No heartbeats — no sender exists.
  return 'parked';
}

function terminal(runStatus: RunItem['status']): DeciderOutput {
  return { outcome: 'terminal', runStatus };
}
