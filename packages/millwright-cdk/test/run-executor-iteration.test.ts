import {
  BuildMappingItem,
  BuildOutcome,
  JobItem,
  RunCoordinates,
  RunItem,
  RunModel,
  RunModelJob,
  buildMappingKey,
  jobKey,
  runKey,
} from '@copperbox/millwright-state';
import { describe, expect, it } from 'vitest';
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

  seedRun(overrides: Partial<RunItem> = {}): void {
    const key = runKey(COORDS);
    this.runs.set(key.pk + key.sk, {
      ...key,
      ...COORDS,
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
  ): Promise<'ok' | 'terminal'> {
    const run = this.runOf(coords);
    if (!run || !['PENDING', 'QUEUED', 'RUNNING'].includes(run.status)) {
      return 'terminal';
    }
    const key = runKey(coords);
    const nowIso = new Date(nowMs).toISOString();
    this.runs.set(key.pk + key.sk, {
      ...run,
      taskToken,
      status: 'RUNNING',
      ...(opts.markStarted ? { startedAt: nowIso, originalStartedAt: nowIso } : {}),
    });
    return 'ok';
  }

  async listJobs(coords: RunCoordinates): Promise<readonly JobItem[]> {
    return [...this.jobs.values()].filter(
      (job) => job.repo === coords.repo && job.runNumber === coords.runNumber,
    );
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

  async finishRun(coords: RunCoordinates, status: RunItem['status'], nowMs: number): Promise<void> {
    const run = this.runOf(coords);
    if (!run || !['PENDING', 'QUEUED', 'RUNNING'].includes(run.status)) {
      return;
    }
    const key = runKey(coords);
    const { taskToken: _dropped, ...rest } = run;
    this.runs.set(key.pk + key.sk, {
      ...rest,
      status,
      finishedAt: new Date(nowMs).toISOString(),
    });
  }

  job(name: string): JobItem | undefined {
    const key = jobKey(COORDS, name);
    return this.jobs.get(key.pk + key.sk);
  }

  run(): RunItem {
    return this.runOf(COORDS)!;
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
    iterationBudget: 100,
    log: () => {},
  };
  return { store, runner, sender, deps };
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
