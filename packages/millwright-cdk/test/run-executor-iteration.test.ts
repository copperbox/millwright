import {
  BuildMappingItem,
  BuildOutcome,
  ConcurrencyGroupItem,
  DesiredCheckState,
  JobItem,
  JobStatus,
  RunCoordinates,
  RunItem,
  RunModel,
  RunModelJob,
  StepItem,
  buildMappingKey,
  cloudWatchLogLink,
  concurrencyGroupKey,
  formatRunId,
  jobKey,
  parseDesiredCheckState,
  runKey,
  serializeDesiredCheckState,
  stepKey,
} from '@copperbox/millwright-state';
import { describe, expect, it } from 'vitest';
import { DesiredCheckWrite } from '../src/runtime/shared/checks';
import { JobProjectionPatch } from '../src/runtime/shared/jobs';
import {
  BuildRunner,
  BuildSnapshot,
  DeciderDeps,
  DeciderStore,
  DispatchContext,
  TokenSender,
  carryOverExecutionName,
  runDeciderIteration,
} from '../src/runtime/run-executor/iteration';

const NOW = Date.parse('2026-08-12T06:00:00Z');
const COORDS: RunCoordinates = { repo: 'octo/app', workflow: 'ci', runNumber: 7 };
const RUN_ID = 'octo/app#ci#7';
const SHA = 'a'.repeat(40);

const MODEL: RunModel = {
  schemaVersion: 1,
  repo: 'octo/app',
  workflows: [
    {
      name: 'ci',
      jobs: [
        { name: 'build', image: 'node:22', steps: [{ run: 'make' }] },
        { name: 'test', image: 'node:22', steps: [{ run: 'make test' }], dependsOn: ['build'] },
      ],
    },
  ],
};

/** In-memory DeciderStore with the DynamoDB implementation's conditions. */
class MemoryStore implements DeciderStore {
  readonly runs = new Map<string, RunItem>();
  readonly jobs = new Map<string, JobItem>();
  readonly mappings = new Map<string, BuildMappingItem>();
  readonly groups = new Map<string, { running?: string; pending?: string }>();
  readonly steps = new Map<string, StepItem>();
  /** Check writes the table accepted, in order. */
  readonly checks: { write: DesiredCheckWrite; nowMs: number }[] = [];
  /** Check writes the ownership/sequence condition rejected. */
  readonly rejectedChecks: DesiredCheckWrite[] = [];
  private readonly checkOwners = new Map<string, { runNumber: number; sequence?: number }>();
  /**
   * When set, check writes are parked here instead of reaching the table —
   * an iteration stalled between its row writes and its check writes.
   * `releaseHeldChecks` lets them land later, as the real writes would.
   */
  heldChecks?: { write: DesiredCheckWrite; nowMs: number }[];
  failCheckWrites = false;
  checksOwnedByNewerRun = false;

  seedRun(overrides: Partial<RunItem> = {}, coords: RunCoordinates = COORDS): void {
    const key = runKey(coords);
    this.runs.set(key.pk + key.sk, {
      ...key,
      ...coords,
      status: 'PENDING',
      trigger: 'push',
      ref: 'refs/heads/main',
      sha: SHA,
      createdAt: new Date(NOW - 5000).toISOString(),
      originalStartedAt: new Date(NOW - 5000).toISOString(),
      expiresAt: 0,
      ...overrides,
    });
  }

  private runOf(coords: RunCoordinates): RunItem | undefined {
    const key = runKey(coords);
    return this.runs.get(key.pk + key.sk);
  }

  async getRun(coords: RunCoordinates): Promise<RunItem | undefined> {
    const run = this.runOf(coords);
    return run ? { ...run } : undefined;
  }

  async beginIteration(
    coords: RunCoordinates,
    taskToken: string,
    opts: { markStarted: boolean },
    nowMs: number,
  ): Promise<{ sequence: number } | 'terminal'> {
    const run = this.runOf(coords);
    if (!run || !['PENDING', 'QUEUED', 'RUNNING'].includes(run.status)) {
      return 'terminal';
    }
    const key = runKey(coords);
    const nowIso = new Date(nowMs).toISOString();
    const sequence = (run.deciderSequence ?? 0) + 1;
    this.runs.set(key.pk + key.sk, {
      ...run,
      taskToken,
      status: 'RUNNING',
      deciderSequence: sequence,
      ...(opts.markStarted ? { startedAt: nowIso, originalStartedAt: nowIso } : {}),
    });
    return { sequence };
  }

  async listRunRows(
    coords: RunCoordinates,
  ): Promise<{ jobs: readonly JobItem[]; steps: readonly StepItem[] }> {
    const of = (row: { repo: string; runNumber: number }) =>
      row.repo === coords.repo && row.runNumber === coords.runNumber;
    return {
      jobs: [...this.jobs.values()].filter(of),
      steps: [...this.steps.values()].filter(of),
    };
  }

  seedStep(job: string, stepIndex: number, overrides: Partial<StepItem> = {}): void {
    const key = stepKey(COORDS, job, stepIndex);
    this.steps.set(key.pk + key.sk, {
      ...key,
      ...COORDS,
      job,
      stepIndex,
      status: 'SUCCEEDED',
      expiresAt: 0,
      ...overrides,
    });
  }

  async putDesiredCheck(write: DesiredCheckWrite, nowMs: number): Promise<boolean> {
    if (this.failCheckWrites) {
      throw new Error('injected check-table error');
    }
    if (this.heldChecks) {
      this.heldChecks.push({ write, nowMs });
      return true;
    }
    return this.applyCheck(write, nowMs);
  }

  /** The DynamoDB condition of `desiredCheckUpsert`, applied in memory. */
  private applyCheck(write: DesiredCheckWrite, nowMs: number): boolean {
    if (this.checksOwnedByNewerRun) {
      this.checks.push({ write, nowMs });
      return false;
    }
    const owner = this.checkOwners.get(write.context);
    const sequenced = write.ownerSequence !== undefined;
    const sameRunInOrder =
      owner?.runNumber === write.ownerRunNumber &&
      (!sequenced || owner.sequence === undefined || owner.sequence <= write.ownerSequence!);
    if (owner && owner.runNumber > write.ownerRunNumber) {
      this.rejectedChecks.push(write);
      return false;
    }
    if (owner && owner.runNumber === write.ownerRunNumber && !sameRunInOrder) {
      this.rejectedChecks.push(write);
      return false;
    }
    this.checkOwners.set(write.context, {
      runNumber: write.ownerRunNumber,
      sequence: sequenced ? write.ownerSequence : owner?.sequence,
    });
    this.checks.push({ write, nowMs });
    return true;
  }

  /** Let the parked check writes reach the table now; returns each write's outcome. */
  releaseHeldChecks(): boolean[] {
    const held = this.heldChecks ?? [];
    this.heldChecks = undefined;
    return held.map(({ write, nowMs }) => this.applyCheck(write, nowMs));
  }

  async markJobChecked(coords: RunCoordinates, job: string, status: JobStatus): Promise<void> {
    const key = jobKey(coords, job);
    const row = this.jobs.get(key.pk + key.sk);
    if (row) {
      this.jobs.set(key.pk + key.sk, { ...row, checkedStatus: status });
    }
  }

  /** The check writes for one job, oldest first, as the reporter would read them. */
  checkHistory(job: string): DesiredCheckState[] {
    return this.checks
      .filter((c) => c.write.context === `ci / ${job}`)
      .map((c) => parseDesiredCheckState(serializeDesiredCheckState(c.write.desired)));
  }

  async claimDispatch(
    coords: RunCoordinates,
    job: string,
    expectedAttempts: number,
    nowMs: number,
  ): Promise<boolean> {
    const key = jobKey(coords, job);
    const row = this.jobs.get(key.pk + key.sk);
    if ((row?.attempts ?? 0) !== expectedAttempts) {
      return false;
    }
    this.jobs.set(key.pk + key.sk, {
      ...key,
      ...COORDS,
      job,
      status: 'QUEUED',
      attempts: expectedAttempts + 1,
      dispatchedAt: new Date(nowMs).toISOString(),
      expiresAt: 0,
    });
    return true;
  }

  async recordDispatch(
    coords: RunCoordinates,
    job: string,
    attempts: number,
    buildId: string,
    buildArn: string | undefined,
    _nowMs: number,
  ): Promise<void> {
    const key = jobKey(coords, job);
    const row = this.jobs.get(key.pk + key.sk);
    if (row?.attempts !== attempts) {
      return;
    }
    this.jobs.set(key.pk + key.sk, { ...row, buildId, buildArn: buildArn ?? buildId });
    this.mappings.set(buildId, {
      ...buildMappingKey(buildId),
      repo: coords.repo,
      workflow: coords.workflow,
      runNumber: coords.runNumber,
      job,
    });
  }

  async seedReusedJob(
    coords: RunCoordinates,
    job: string,
    reusedFrom: string,
    nowMs: number,
  ): Promise<void> {
    const key = jobKey(coords, job);
    if (this.jobs.has(key.pk + key.sk)) {
      return;
    }
    this.jobs.set(key.pk + key.sk, {
      ...key,
      ...COORDS,
      job,
      status: 'SUCCEEDED',
      reusedFrom,
      finishedAt: new Date(nowMs).toISOString(),
      expiresAt: 0,
    });
  }

  async writeJobProjection(
    coords: RunCoordinates,
    job: string,
    patch: JobProjectionPatch,
    _nowMs: number,
  ): Promise<void> {
    const key = jobKey(coords, job);
    const row = this.jobs.get(key.pk + key.sk);
    if (patch.ifBuildId !== undefined && row?.buildId !== patch.ifBuildId) {
      return;
    }
    this.jobs.set(key.pk + key.sk, {
      ...(row ?? { ...key, ...COORDS, job, status: patch.status, expiresAt: 0 }),
      status: patch.status,
      ...(patch.skipReason !== undefined ? { skipReason: patch.skipReason } : {}),
      ...(patch.logStreamName !== undefined ? { logStreamName: patch.logStreamName } : {}),
      ...(patch.startedAt !== undefined ? { startedAt: patch.startedAt } : {}),
      ...(patch.finishedAt !== undefined ? { finishedAt: patch.finishedAt } : {}),
    });
  }

  async finishRun(
    coords: RunCoordinates,
    status: RunItem['status'],
    sequence: number,
    nowMs: number,
  ): Promise<boolean> {
    const run = this.runOf(coords);
    if (!run || !['PENDING', 'QUEUED', 'RUNNING'].includes(run.status)) {
      return false;
    }
    // The DynamoDB fence: only the run's current iteration may end it.
    if (run.deciderSequence !== sequence) {
      return false;
    }
    const key = runKey(coords);
    const { taskToken: _dropped, ...rest } = run;
    this.runs.set(key.pk + key.sk, {
      ...rest,
      status,
      finishedAt: new Date(nowMs).toISOString(),
    });
    return true;
  }

  async getGroup(group: string): Promise<ConcurrencyGroupItem | undefined> {
    const state = this.groups.get(group);
    return state ? { ...concurrencyGroupKey(group), ...state } : undefined;
  }

  async promotePending(
    group: string,
    expected: { running: string; pending: string },
  ): Promise<boolean> {
    const state = this.groups.get(group);
    if (state?.running !== expected.running || state?.pending !== expected.pending) {
      return false;
    }
    this.groups.set(group, { running: expected.pending });
    return true;
  }

  async clearRunning(group: string, expectedRunning: string): Promise<boolean> {
    const state = this.groups.get(group);
    if (state?.running !== expectedRunning || state.pending !== undefined) {
      return false;
    }
    this.groups.set(group, {});
    return true;
  }

  async dropPending(
    group: string,
    expected: { running: string; pending: string },
  ): Promise<boolean> {
    const state = this.groups.get(group);
    if (state?.running !== expected.running || state?.pending !== expected.pending) {
      return false;
    }
    this.groups.set(group, { running: state.running });
    return true;
  }

  job(name: string): JobItem | undefined {
    const key = jobKey(COORDS, name);
    return this.jobs.get(key.pk + key.sk);
  }

  run(coords: RunCoordinates = COORDS): RunItem {
    return this.runOf(coords)!;
  }
}

class FakeRunner implements BuildRunner {
  readonly builds = new Map<string, BuildSnapshot>();
  readonly started: { job: string; ctx: DispatchContext }[] = [];
  readonly stopped: string[] = [];
  failNextStart = false;
  private sequence = 0;

  async start(job: RunModelJob, ctx: DispatchContext): Promise<{ buildId: string }> {
    if (this.failNextStart) {
      this.failNextStart = false;
      throw new Error('StartBuild rejected');
    }
    const buildId = `mw-builds:${++this.sequence}`;
    this.builds.set(buildId, { outcome: 'IN_PROGRESS', phase: 'BUILD' });
    this.started.push({ job: job.name, ctx });
    return { buildId };
  }

  async stop(buildId: string): Promise<void> {
    this.stopped.push(buildId);
    this.builds.set(buildId, { outcome: 'STOPPED' });
  }

  async getStatuses(buildIds: readonly string[]): Promise<ReadonlyMap<string, BuildSnapshot>> {
    const result = new Map<string, BuildSnapshot>();
    for (const id of buildIds) {
      const build = this.builds.get(id);
      if (build) {
        result.set(id, build);
      }
    }
    return result;
  }

  finish(buildId: string, outcome: BuildOutcome): void {
    this.builds.set(buildId, { outcome, logStreamName: `stream-${buildId}` });
  }
}

/** Records hand-off StartExecutions, idempotent like the SFN starter. */
class FakeStarter {
  readonly startedRuns: string[] = [];

  async startRun(run: RunItem): Promise<void> {
    const id = formatRunId(run);
    if (!this.startedRuns.includes(id)) {
      this.startedRuns.push(id);
    }
  }
}

class FakeSender implements TokenSender {
  readonly successes: { taskToken: string; output: unknown }[] = [];
  readonly failures: { taskToken: string; error: string; cause: string }[] = [];

  async success(taskToken: string, output: unknown): Promise<void> {
    this.successes.push({ taskToken, output });
  }

  async failure(taskToken: string, error: string, cause: string): Promise<void> {
    this.failures.push({ taskToken, error, cause });
  }
}

function harness(model: RunModel | null = MODEL) {
  const store = new MemoryStore();
  const runner = new FakeRunner();
  const sender = new FakeSender();
  const starter = new FakeStarter();
  const deps: DeciderDeps = {
    store,
    runner,
    models: {
      load: async () => {
        if (!model) {
          throw new Error('no model at runs/octo/app/ci/7/in/model.json');
        }
        return model;
      },
    },
    sender,
    starter,
    iterationBudget: 100,
    log: () => {},
  };
  return { store, runner, sender, starter, deps };
}

function iterate(
  deps: DeciderDeps,
  iteration: number,
  nowMs: number,
  taskToken = `token-${iteration}`,
) {
  return runDeciderIteration(
    deps,
    { taskToken, runId: RUN_ID, iteration, executionName: 'run-abc-123' },
    nowMs,
  );
}

describe('decider iteration — happy path', () => {
  it('drives a two-job chain to completion on timeout re-entries alone', async () => {
    const { store, runner, sender, deps } = harness();
    store.seedRun();

    // Iteration 0: dispatch the root job, park on the token.
    expect(await iterate(deps, 0, NOW)).toBe('parked');
    expect(runner.started.map((s) => s.job)).toEqual(['build']);
    expect(store.job('build')).toMatchObject({ status: 'QUEUED', attempts: 1 });
    expect(store.run().taskToken).toBe('token-0');
    expect(store.run().status).toBe('RUNNING');

    // Build completes; the (timeout-driven) next entry dispatches the dependent.
    runner.finish('mw-builds:1', 'SUCCEEDED');
    expect(await iterate(deps, 1, NOW + 60_000)).toBe('parked');
    expect(runner.started.map((s) => s.job)).toEqual(['build', 'test']);
    expect(store.job('build')).toMatchObject({ status: 'SUCCEEDED' });
    expect(store.run().taskToken).toBe('token-1');

    // Second build completes; the run finishes and its own token is completed.
    runner.finish('mw-builds:2', 'SUCCEEDED');
    expect(await iterate(deps, 2, NOW + 120_000)).toBe('terminal');
    expect(store.run().status).toBe('SUCCEEDED');
    expect(store.run().taskToken).toBeUndefined();
    expect(store.run().finishedAt).toBeDefined();
    expect(sender.successes.at(-1)).toEqual({
      taskToken: 'token-2',
      output: { outcome: 'terminal', runStatus: 'SUCCEEDED' },
    });
  });

  it('writes the BUILD# mapping with run/job identity at dispatch', async () => {
    const { store, deps } = harness();
    store.seedRun();
    await iterate(deps, 0, NOW);
    expect(store.mappings.get('mw-builds:1')).toMatchObject({
      pk: 'BUILD#mw-builds:1',
      repo: 'octo/app',
      workflow: 'ci',
      runNumber: 7,
      job: 'build',
    });
  });

  it('stamps the deadline anchor on first start and never resets it', async () => {
    const { store, runner, deps } = harness();
    store.seedRun();
    await iterate(deps, 0, NOW);
    const anchor = store.run().originalStartedAt;
    expect(anchor).toBe(new Date(NOW).toISOString());

    runner.finish('mw-builds:1', 'SUCCEEDED');
    await iterate(deps, 1, NOW + 3_600_000);
    expect(store.run().originalStartedAt).toBe(anchor);
  });

  it('passes run context to StartBuild', async () => {
    const { store, runner, deps } = harness();
    store.seedRun();
    await iterate(deps, 0, NOW);
    expect(runner.started[0].ctx).toMatchObject({
      runId: RUN_ID,
      sha: SHA,
      ref: 'refs/heads/main',
      coords: COORDS,
    });
  });
});

describe('decider iteration — reconciliation and races', () => {
  it('converges a hand-poisoned SUCCEEDED row from BatchGetBuilds ground truth', async () => {
    const { store, runner, sender, deps } = harness();
    store.seedRun({ status: 'RUNNING', startedAt: new Date(NOW - 60_000).toISOString() });
    await store.claimDispatch(COORDS, 'build', 0, NOW - 60_000);
    await store.recordDispatch(COORDS, 'build', 1, 'mw-builds:poisoned', undefined, NOW - 60_000);
    runner.builds.set('mw-builds:poisoned', { outcome: 'FAILED' });
    // Hand-poison the projection.
    await store.writeJobProjection(COORDS, 'build', { status: 'SUCCEEDED' }, NOW - 1000);

    expect(await iterate(deps, 3, NOW)).toBe('terminal');
    expect(runner.started).toEqual([]); // test is skipped, never dispatched
    expect(store.job('build')).toMatchObject({ status: 'FAILED' });
    expect(store.job('test')).toMatchObject({ status: 'SKIPPED', skipReason: 'upstream_failed' });
    expect(store.run().status).toBe('FAILED');
    expect(sender.successes.at(-1)?.output).toEqual({ outcome: 'terminal', runStatus: 'FAILED' });
  });

  it('converges an out-of-band build kill to CANCELLED job, FAILED run', async () => {
    const { store, runner, deps } = harness();
    store.seedRun({ status: 'RUNNING', startedAt: new Date(NOW - 60_000).toISOString() });
    await store.claimDispatch(COORDS, 'build', 0, NOW - 60_000);
    await store.recordDispatch(COORDS, 'build', 1, 'mw-builds:killed', undefined, NOW - 60_000);
    runner.builds.set('mw-builds:killed', { outcome: 'STOPPED' });

    expect(await iterate(deps, 3, NOW)).toBe('terminal');
    expect(store.job('build')).toMatchObject({ status: 'CANCELLED' });
    expect(store.run().status).toBe('FAILED');
  });

  it('skips dispatch quietly when a concurrent iteration claimed first', async () => {
    const { store, runner, deps } = harness();
    store.seedRun();
    // A concurrent iteration already claimed attempt 1 moments ago.
    await store.claimDispatch(COORDS, 'build', 0, NOW - 1000);

    expect(await iterate(deps, 0, NOW)).toBe('parked');
    expect(runner.started).toEqual([]);
    expect(store.job('build')?.attempts).toBe(1);
  });

  it('leaves a failed StartBuild as a bounded stale claim and keeps going', async () => {
    const { store, runner, deps } = harness();
    store.seedRun();
    runner.failNextStart = true;

    expect(await iterate(deps, 0, NOW)).toBe('parked');
    expect(store.job('build')).toMatchObject({ status: 'QUEUED', attempts: 1 });
    expect(store.job('build')?.buildId).toBeUndefined();
  });

  it('sends terminal immediately when the run is already finished', async () => {
    const { store, sender, deps } = harness();
    store.seedRun({ status: 'CANCELLED' });
    expect(await iterate(deps, 5, NOW)).toBe('terminal');
    expect(sender.successes).toEqual([
      { taskToken: 'token-5', output: { outcome: 'terminal', runStatus: 'CANCELLED' } },
    ]);
  });

  it('fails the token when the run record does not exist', async () => {
    const { sender, deps } = harness();
    expect(await iterate(deps, 0, NOW)).toBe('failed');
    expect(sender.failures[0]).toMatchObject({ error: 'RunNotFound' });
  });

  it('fails the token when the model is unavailable', async () => {
    const { store, sender, deps } = harness(null);
    store.seedRun();
    expect(await iterate(deps, 0, NOW)).toBe('failed');
    expect(sender.failures[0]).toMatchObject({ error: 'ModelUnavailable' });
  });
});

describe('decider iteration — rerun seeding (spec §7.7)', () => {
  it('seeds reused jobs terminal SUCCEEDED with reusedFrom; dependents dispatch at once', async () => {
    const { store, runner, deps } = harness();
    store.seedRun({ trigger: 'rerun', rerunOf: 'octo/app#ci#6', reuseJobs: ['build'] });

    expect(await iterate(deps, 0, NOW)).toBe('parked');
    expect(store.job('build')).toMatchObject({
      status: 'SUCCEEDED',
      reusedFrom: 'octo/app#ci#6',
    });
    expect(store.job('build')?.buildId).toBeUndefined();
    // The reused success satisfies its dependents without a build.
    expect(runner.started.map((s) => s.job)).toEqual(['test']);
  });

  it('never reseeds over an existing row on re-entry', async () => {
    const { store, runner, deps } = harness();
    store.seedRun({ trigger: 'rerun', rerunOf: 'octo/app#ci#6', reuseJobs: ['build'] });
    await iterate(deps, 0, NOW);

    // The dispatched dependent fails; a later entry must not resurrect it
    // or touch the seeded row.
    runner.finish('mw-builds:1', 'FAILED');
    expect(await iterate(deps, 1, NOW + 60_000)).toBe('terminal');
    expect(store.job('build')).toMatchObject({ status: 'SUCCEEDED', reusedFrom: 'octo/app#ci#6' });
    expect(store.job('test')).toMatchObject({ status: 'FAILED' });
    expect(store.run().status).toBe('FAILED');
  });

  it('completes immediately when every job is reused', async () => {
    const { store, runner, sender, deps } = harness();
    store.seedRun({ trigger: 'rerun', rerunOf: 'octo/app#ci#6', reuseJobs: ['build', 'test'] });

    expect(await iterate(deps, 0, NOW)).toBe('terminal');
    expect(runner.started).toEqual([]);
    expect(store.run().status).toBe('SUCCEEDED');
    expect(sender.successes.at(-1)?.output).toEqual({
      outcome: 'terminal',
      runStatus: 'SUCCEEDED',
    });
  });
});

describe('decider iteration — cancellation and carry-over', () => {
  it('stops builds, cancels jobs and the run when cancelRequested is set', async () => {
    const { store, runner, sender, deps } = harness();
    store.seedRun({ status: 'RUNNING', startedAt: new Date(NOW - 60_000).toISOString() });
    await store.claimDispatch(COORDS, 'build', 0, NOW - 30_000);
    await store.recordDispatch(COORDS, 'build', 1, 'mw-builds:live', undefined, NOW - 30_000);
    runner.builds.set('mw-builds:live', { outcome: 'IN_PROGRESS' });
    store.seedRun({
      status: 'RUNNING',
      startedAt: new Date(NOW - 60_000).toISOString(),
      cancelRequested: true,
    });

    expect(await iterate(deps, 2, NOW)).toBe('terminal');
    expect(runner.stopped).toEqual(['mw-builds:live']);
    expect(store.job('build')).toMatchObject({ status: 'CANCELLED' });
    expect(store.job('test')).toMatchObject({ status: 'CANCELLED' });
    expect(store.run().status).toBe('CANCELLED');
    expect(sender.successes.at(-1)?.output).toEqual({
      outcome: 'terminal',
      runStatus: 'CANCELLED',
    });
  });

  it('carries over at the iteration budget with a deterministic resume input', async () => {
    const { store, sender, deps } = harness();
    store.seedRun();

    expect(await iterate(deps, 100, NOW)).toBe('carry-over');
    const output = sender.successes.at(-1)?.output as {
      outcome: string;
      carryOver: { name: string; input: unknown };
    };
    expect(output.outcome).toBe('carry-over');
    expect(output.carryOver.name).toBe(carryOverExecutionName('run-abc-123'));
    expect(output.carryOver.name).toMatch(/^co-[0-9a-f]{40}$/);
    expect(output.carryOver.input).toEqual({
      action: 'run',
      resume: true,
      runId: RUN_ID,
      repo: 'octo/app',
      workflow: 'ci',
      runNumber: 7,
    });
    // The loop's work still happened before handing over.
    expect(store.job('build')).toMatchObject({ status: 'QUEUED', attempts: 1 });
  });

  it('derives distinct carry-over names generation after generation', () => {
    const first = carryOverExecutionName('run-abc-123');
    const second = carryOverExecutionName(first);
    expect(first).not.toBe(second);
    expect(carryOverExecutionName('run-abc-123')).toBe(first);
  });
});

describe('decider iteration — concurrency-group hand-off (spec §8.4)', () => {
  const GROUP = 'deploy-octo/app';
  const PENDING_COORDS: RunCoordinates = { repo: 'octo/app', workflow: 'ci', runNumber: 8 };
  const PENDING_ID = 'octo/app#ci#8';

  it('clears the running slot on completion when no run is waiting', async () => {
    const { store, starter, deps } = harness();
    store.seedRun({ concurrencyGroup: GROUP, cancelRequested: true });
    store.groups.set(GROUP, { running: RUN_ID });

    expect(await iterate(deps, 0, NOW)).toBe('terminal');
    expect(store.groups.get(GROUP)).toEqual({});
    expect(starter.startedRuns).toEqual([]);
  });

  it('starts the pending run and promotes it into the running slot (serialization)', async () => {
    const { store, starter, deps } = harness();
    store.seedRun({ concurrencyGroup: GROUP, cancelRequested: true });
    store.seedRun({ status: 'QUEUED', concurrencyGroup: GROUP }, PENDING_COORDS);
    store.groups.set(GROUP, { running: RUN_ID, pending: PENDING_ID });

    expect(await iterate(deps, 0, NOW)).toBe('terminal');
    expect(starter.startedRuns).toEqual([PENDING_ID]);
    expect(store.groups.get(GROUP)).toEqual({ running: PENDING_ID });
    // The handed-off run stays QUEUED until its own first iteration starts it.
    expect(store.run(PENDING_COORDS).status).toBe('QUEUED');
  });

  it('leaves a slot held by another run untouched', async () => {
    const { store, starter, deps } = harness();
    store.seedRun({ concurrencyGroup: GROUP, cancelRequested: true });
    store.groups.set(GROUP, { running: 'octo/app#ci#99' });

    expect(await iterate(deps, 0, NOW)).toBe('terminal');
    expect(store.groups.get(GROUP)).toEqual({ running: 'octo/app#ci#99' });
    expect(starter.startedRuns).toEqual([]);
  });

  it('releases the slot handed to a run that was cancelled while QUEUED', async () => {
    const { store, sender, deps } = harness();
    // A hand-off started this run after a CLI cancel landed: its only
    // iteration takes the already-terminal early exit, which must release.
    store.seedRun({ status: 'CANCELLED', concurrencyGroup: GROUP });
    store.groups.set(GROUP, { running: RUN_ID });

    expect(await iterate(deps, 0, NOW)).toBe('terminal');
    expect(store.groups.get(GROUP)).toEqual({});
    expect(sender.successes.at(-1)?.output).toEqual({
      outcome: 'terminal',
      runStatus: 'CANCELLED',
    });
  });

  it('drops a pending occupant whose run record no longer exists, then clears', async () => {
    const { store, starter, deps } = harness();
    store.seedRun({ concurrencyGroup: GROUP, cancelRequested: true });
    store.groups.set(GROUP, { running: RUN_ID, pending: 'octo/app#ci#42' });

    expect(await iterate(deps, 0, NOW)).toBe('terminal');
    expect(store.groups.get(GROUP)).toEqual({});
    expect(starter.startedRuns).toEqual([]);
  });

  it('never fails the completion when the release contends past its attempts', async () => {
    const { store, sender, deps } = harness();
    store.seedRun({ concurrencyGroup: GROUP, cancelRequested: true });
    store.groups.set(GROUP, { running: RUN_ID });
    // Every conditional write loses: simulate perpetual contention.
    store.clearRunning = async () => false;

    expect(await iterate(deps, 0, NOW)).toBe('terminal');
    expect(sender.successes.at(-1)?.output).toEqual({
      outcome: 'terminal',
      runStatus: 'CANCELLED',
    });
  });
});

describe('decider iteration — per-job checks (spec §13.2 lifecycle, #51)', () => {
  const phase = (d: DesiredCheckState) => (d.conclusion ? `${d.status}/${d.conclusion}` : d.status);

  it('walks one job from queued through in_progress to success, owned by the run', async () => {
    const { store, runner, deps } = harness();
    store.seedRun();

    // Synth is done, the loop begins: the root dispatches (in_progress), its
    // dependent is created queued.
    await iterate(deps, 0, NOW);
    expect(store.checkHistory('build').map(phase)).toEqual(['in_progress']);
    expect(store.checkHistory('test').map(phase)).toEqual(['queued']);

    runner.finish('mw-builds:1', 'SUCCEEDED');
    await iterate(deps, 1, NOW + 60_000);
    expect(store.checkHistory('build').map(phase)).toEqual(['in_progress', 'completed/success']);
    expect(store.checkHistory('test').map(phase)).toEqual(['queued', 'in_progress']);

    runner.finish('mw-builds:2', 'SUCCEEDED');
    expect(await iterate(deps, 2, NOW + 120_000)).toBe('terminal');
    expect(store.checkHistory('test').map(phase)).toEqual([
      'queued',
      'in_progress',
      'completed/success',
    ]);
    expect(phase(store.checkHistory('build').at(-1)!)).toBe('completed/success');

    for (const { write, nowMs } of store.checks) {
      expect(write).toMatchObject({ repo: 'octo/app', sha: SHA, ownerRun: 'ci#7', ownerRunNumber: 7 });
      expect(write.context).toMatch(/^ci \/ (build|test)$/);
      expect(write.desired.summary).toContain('ci#7');
      expect(nowMs).toBeGreaterThanOrEqual(NOW);
    }
    // Each iteration stamps its own sequence; the rows remember what was written.
    expect(store.checks.map((c) => c.write.ownerSequence)).toEqual([1, 1, 2, 2, 3, 3]);
    expect(store.run().deciderSequence).toBe(3);
    expect(store.job('build')?.checkedStatus).toBe('SUCCEEDED');
    expect(store.job('test')?.checkedStatus).toBe('SUCCEEDED');
  });

  it('completes a check whose terminal status the build-events handler projected before the iteration', async () => {
    const { store, runner, deps } = harness();
    store.seedRun();
    await iterate(deps, 0, NOW);
    expect(store.job('build')).toMatchObject({ status: 'QUEUED', checkedStatus: 'QUEUED' });

    // The build finishes and the build-events handler projects SUCCEEDED onto
    // the row before waking the loop: the iteration reads SUCCEEDED from the
    // start, so a before/after snapshot of its own writes would never change.
    runner.finish('mw-builds:1', 'SUCCEEDED');
    await store.writeJobProjection(
      COORDS,
      'build',
      { status: 'SUCCEEDED', logStreamName: 'stream-mw-builds:1', ifBuildId: 'mw-builds:1' },
      NOW + 30_000,
    );
    expect(store.job('build')).toMatchObject({ status: 'SUCCEEDED', checkedStatus: 'QUEUED' });

    // The dependent dispatches, so the run is NOT terminal: the completion
    // must come from the phase comparison, not the terminal safety net.
    expect(await iterate(deps, 1, NOW + 60_000)).toBe('parked');
    expect(store.checkHistory('build').map(phase)).toEqual(['in_progress', 'completed/success']);
    expect(store.job('build')?.checkedStatus).toBe('SUCCEEDED');
    expect(store.checkHistory('test').map(phase)).toEqual(['queued', 'in_progress']);

    // And the next quiet re-entry writes nothing more.
    const written = store.checks.length;
    await iterate(deps, 2, NOW + 120_000);
    expect(store.checks).toHaveLength(written);
  });

  it('drops a stalled in_progress write that lands after a later iteration completed the run', async () => {
    const { store, runner, deps } = harness();
    store.seedRun();

    // Iteration 0 dispatches build, but its check writes stall in flight.
    store.heldChecks = [];
    expect(await iterate(deps, 0, NOW)).toBe('parked');
    expect(store.heldChecks.map((h) => h.write.desired.status)).toEqual(['in_progress', 'queued']);
    const stalled = store.heldChecks;
    store.heldChecks = undefined;

    // Meanwhile the build fails fast, the event wakes the loop and the next
    // iteration finishes the run: build failed, test skipped.
    runner.finish('mw-builds:1', 'FAILED');
    expect(await iterate(deps, 1, NOW + 2_000)).toBe('terminal');
    expect(phase(store.checkHistory('build').at(-1)!)).toBe('completed/failure');
    expect(phase(store.checkHistory('test').at(-1)!)).toBe('completed/skipped');

    // Now the stalled writes arrive. Both share the run's number with the
    // completed writes; only the sequence fence tells them apart.
    store.heldChecks = stalled;
    expect(store.releaseHeldChecks()).toEqual([false, false]);
    expect(store.rejectedChecks.map((w) => [w.context, w.ownerSequence])).toEqual([
      ['ci / build', 1],
      ['ci / test', 1],
    ]);
    expect(phase(store.checkHistory('build').at(-1)!)).toBe('completed/failure');
    expect(phase(store.checkHistory('test').at(-1)!)).toBe('completed/skipped');
  });

  it('leaves completion to the current iteration when a stalled older one observes it first', async () => {
    const single: RunModel = {
      ...MODEL,
      workflows: [{ name: 'ci', jobs: [{ name: 'build', image: 'node:22', steps: [{ run: 'make' }] }] }],
    };
    const { store, runner, sender, deps } = harness(single);
    store.seedRun();

    // Iteration A writes its token (sequence 1), then stalls loading the model.
    let releaseA!: () => void;
    const gate = new Promise<void>((resolve) => {
      releaseA = resolve;
    });
    let loads = 0;
    const gated: DeciderDeps = {
      ...deps,
      models: {
        load: async () => {
          if (loads++ === 0) {
            await gate;
          }
          return single;
        },
      },
    };
    const a = iterate(gated, 0, NOW, 'token-a');
    while (store.run().deciderSequence !== 1) {
      await Promise.resolve();
    }

    // The 60 s timeout re-enters: B (sequence 2) dispatches the build and
    // writes in_progress. The build then succeeds before A resumes.
    expect(await iterate(gated, 1, NOW + 60_000, 'token-b')).toBe('parked');
    expect(store.checkHistory('build').map(phase)).toEqual(['in_progress']);
    runner.finish('mw-builds:1', 'SUCCEEDED');

    // A resumes and observes the success, but it is no longer the current
    // iteration: its completed write loses to B's ownerSequence and it must
    // NOT end the run either, or nothing would ever complete the check.
    releaseA();
    expect(await a).toBe('superseded');
    expect(store.rejectedChecks.map((w) => [w.context, w.ownerSequence])).toEqual([
      ['ci / build', 1],
    ]);
    expect(phase(store.checkHistory('build').at(-1)!)).toBe('in_progress');
    expect(store.run()).toMatchObject({ status: 'RUNNING', deciderSequence: 2 });
    expect(sender.successes.map((s) => s.taskToken)).not.toContain('token-a');

    // The current iteration re-derives the completion and writes the check.
    expect(await iterate(gated, 2, NOW + 120_000, 'token-c')).toBe('terminal');
    expect(phase(store.checkHistory('build').at(-1)!)).toBe('completed/success');
    expect(store.checks.at(-1)!.write.ownerSequence).toBe(3);
    expect(store.run()).toMatchObject({ status: 'SUCCEEDED', deciderSequence: 3 });
    expect(sender.successes.at(-1)).toMatchObject({
      taskToken: 'token-c',
      output: { outcome: 'terminal', runStatus: 'SUCCEEDED' },
    });
  });

  it('deep-links a check to its build log stream when the deployment’s log location is known', async () => {
    const { store, runner, deps } = harness();
    const logs = { region: 'eu-west-1', logGroup: '/millwright/ci/builds' };
    store.seedRun();
    await iterate({ ...deps, logs }, 0, NOW);
    runner.finish('mw-builds:1', 'FAILED');
    expect(await iterate({ ...deps, logs }, 1, NOW + 60_000)).toBe('terminal');

    const build = store.checkHistory('build').at(-1)!;
    expect(build.detailsUrl).toBe(cloudWatchLogLink(logs.region, logs.logGroup, 'stream-mw-builds:1'));
    // The never-started dependent has no stream to link.
    expect(store.checkHistory('test').at(-1)!.detailsUrl).toBeUndefined();
  });

  it('writes nothing when an iteration changes nothing', async () => {
    const { store, deps } = harness();
    store.seedRun();
    await iterate(deps, 0, NOW);
    const written = store.checks.length;
    await iterate(deps, 1, NOW + 60_000); // build still IN_PROGRESS, test still queued
    expect(store.checks).toHaveLength(written);
  });

  it('reports failure with the step table and triage command, and skipped dependents as skipped', async () => {
    const { store, runner, deps } = harness();
    store.seedRun();
    await iterate(deps, 0, NOW);
    store.seedStep('build', 0, {
      name: 'npm ci',
      status: 'SUCCEEDED',
      startedAt: new Date(NOW).toISOString(),
      finishedAt: new Date(NOW + 4_000).toISOString(),
    });
    store.seedStep('build', 1, { name: 'npm test', status: 'FAILED' });
    runner.finish('mw-builds:1', 'FAILED');

    expect(await iterate(deps, 1, NOW + 60_000)).toBe('terminal');
    expect(store.run().status).toBe('FAILED');

    const build = store.checkHistory('build').at(-1)!;
    expect(phase(build)).toBe('completed/failure');
    expect(build.summary).toContain('| npm ci | SUCCEEDED | 4s |');
    expect(build.summary).toContain('| npm test | FAILED | — |');
    expect(build.summary).toContain('millwright logs octo/app/ci#7 --job build');

    const test = store.checkHistory('test').at(-1)!;
    expect(phase(test)).toBe('completed/skipped');
    expect(test.summary).not.toContain('millwright logs');
  });

  it('reports cancellation for live and never-started jobs alike', async () => {
    const { store, deps } = harness();
    store.seedRun();
    await iterate(deps, 0, NOW);
    store.seedRun({
      status: 'RUNNING',
      startedAt: new Date(NOW).toISOString(),
      cancelRequested: true,
    });
    expect(await iterate(deps, 1, NOW + 60_000)).toBe('terminal');
    expect(phase(store.checkHistory('build').at(-1)!)).toBe('completed/cancelled');
    expect(phase(store.checkHistory('test').at(-1)!)).toBe('completed/cancelled');
  });

  it('reports rerun-reused jobs as succeeded at once', async () => {
    const { store, deps } = harness();
    store.seedRun({ rerunOf: 'octo/app#ci#6', reuseJobs: ['build'] });
    await iterate(deps, 0, NOW);
    expect(store.checkHistory('build').map(phase)).toEqual(['completed/success']);
    expect(store.checkHistory('test').map(phase)).toEqual(['in_progress']);
  });

  it('never lets a check write failure or a lost ownership race fail the iteration', async () => {
    const failing = harness();
    failing.store.seedRun();
    failing.store.failCheckWrites = true;
    expect(await iterate(failing.deps, 0, NOW)).toBe('parked');
    expect(failing.store.run().status).toBe('RUNNING');
    expect(failing.runner.started.map((s) => s.job)).toEqual(['build']);

    const owned = harness();
    owned.store.seedRun();
    owned.store.checksOwnedByNewerRun = true;
    expect(await iterate(owned.deps, 0, NOW)).toBe('parked');
    expect(owned.store.checks.length).toBeGreaterThan(0);
  });
});
