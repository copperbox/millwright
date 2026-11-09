import {
  ConcurrencyGroupItem,
  RunCoordinates,
  RunItem,
  RunStatus,
  checkStateKey,
  concurrencyGroupKey,
  formatRunId,
  parseDesiredCheckState,
  runKey,
} from '@copperbox/millwright-state';
import { describe, expect, it } from 'vitest';
import { DesiredCheckWrite } from '../src/runtime/shared/checks';
import {
  SynthFailureDeps,
  SynthFailureStore,
  recordSynthFailure,
  synthFailureMessage,
} from '../src/runtime/synth-failure/synth-failure';

const NOW = Date.parse('2026-08-12T06:00:00Z');
const SHA = 'a'.repeat(40);
const ME = 'octocat/app#deploy#1';
const WAITER = 'octocat/app#deploy#2';

const RUN_INPUT = {
  action: 'run' as const,
  runId: ME,
  repo: 'octocat/app',
  workflow: 'deploy',
  runNumber: 1,
  ref: 'refs/heads/main',
  sha: SHA,
  trigger: 'push',
};

const SYNTH_ONLY_INPUT = {
  action: 'synth-only' as const,
  repo: 'octocat/app',
  ref: 'refs/heads/main',
  sha: SHA,
};

/** In-memory store mirroring the DynamoDB implementation's conditions. */
class MemoryStore implements SynthFailureStore {
  readonly groups = new Map<string, { running?: string; pending?: string }>();
  readonly runs = new Map<string, RunItem>();
  readonly checks: { write: DesiredCheckWrite; nowMs: number }[] = [];
  failFinish?: Error;
  failCheck?: Error;

  putRun(runId: string, status: RunStatus, group?: string): void {
    const [repo, workflow, number] = runId.split('#');
    const coords: RunCoordinates = { repo, workflow, runNumber: Number(number) };
    const key = runKey(coords);
    this.runs.set(key.pk + key.sk, {
      ...key,
      ...coords,
      status,
      trigger: 'push',
      ref: 'refs/heads/main',
      sha: SHA,
      createdAt: new Date(NOW - 60_000).toISOString(),
      originalStartedAt: new Date(NOW - 60_000).toISOString(),
      ...(group ? { concurrencyGroup: group } : {}),
      expiresAt: 0,
    });
  }

  run(runId: string): RunItem | undefined {
    const key = runKey(parseCoords(runId));
    return this.runs.get(key.pk + key.sk);
  }

  async getGroup(group: string): Promise<ConcurrencyGroupItem | undefined> {
    const state = this.groups.get(group);
    return state ? { ...concurrencyGroupKey(group), ...state } : undefined;
  }

  async getRun(coords: RunCoordinates): Promise<RunItem | undefined> {
    const key = runKey(coords);
    const run = this.runs.get(key.pk + key.sk);
    return run ? { ...run } : undefined;
  }

  async finishRun(coords: RunCoordinates, status: RunStatus, nowMs: number): Promise<boolean> {
    if (this.failFinish) {
      throw this.failFinish;
    }
    const key = runKey(coords);
    const run = this.runs.get(key.pk + key.sk);
    if (!run || !['PENDING', 'QUEUED', 'RUNNING'].includes(run.status)) {
      return false;
    }
    const { taskToken: _token, ...rest } = run;
    this.runs.set(key.pk + key.sk, {
      ...rest,
      status,
      finishedAt: new Date(nowMs).toISOString(),
    });
    return true;
  }

  async putDesiredCheck(write: DesiredCheckWrite, nowMs: number): Promise<boolean> {
    if (this.failCheck) {
      throw this.failCheck;
    }
    this.checks.push({ write, nowMs });
    return true;
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
}

function parseCoords(runId: string): RunCoordinates {
  const [repo, workflow, number] = runId.split('#');
  return { repo, workflow, runNumber: Number(number) };
}

function harness(): {
  deps: SynthFailureDeps;
  store: MemoryStore;
  started: string[];
  logs: string[];
} {
  const store = new MemoryStore();
  const started: string[] = [];
  const logs: string[] = [];
  const deps: SynthFailureDeps = {
    store,
    starter: {
      startRun: async (run) => {
        started.push(formatRunId(run));
      },
    },
    log: (message) => {
      logs.push(message);
    },
  };
  return { deps, store, started, logs };
}

const JOB_FAILED = {
  Error: 'SynthJobFailed',
  Cause: 'workflows.ts:12 unknown trigger "pushh"',
};

describe('synthFailureMessage', () => {
  it('uses a plain cause verbatim', () => {
    expect(synthFailureMessage(JOB_FAILED)).toBe('workflows.ts:12 unknown trigger "pushh"');
  });

  it('unwraps a Lambda error cause to its errorMessage', () => {
    const cause = JSON.stringify({
      errorType: 'PostSynthError',
      errorMessage: 'Invalid run model: workflows[0].jobs: must not be empty',
      trace: ['PostSynthError: ...'],
    });
    expect(synthFailureMessage({ Error: 'PostSynthError', Cause: cause })).toBe(
      'Invalid run model: workflows[0].jobs: must not be empty',
    );
  });

  it('falls back to the error name, then a generic message', () => {
    expect(synthFailureMessage({ Error: 'States.Timeout' })).toBe('States.Timeout');
    expect(synthFailureMessage({ Error: 'States.Timeout', Cause: '' })).toBe('States.Timeout');
    expect(synthFailureMessage(undefined)).toBe('The synth job or post-synth validation failed');
  });
});

describe('recordSynthFailure — a failed synth ends the run visibly (issue #50)', () => {
  it('marks the run FAILED with finishedAt and clears a group slot with no waiter', async () => {
    const { deps, store, started } = harness();
    store.putRun(ME, 'PENDING', 'deploy-main');
    store.groups.set('deploy-main', { running: ME });

    const result = await recordSynthFailure(deps, { input: RUN_INPUT, synthError: JOB_FAILED }, NOW);

    expect(result).toMatchObject({ outcome: 'failed', runId: ME, group: 'cleared' });
    expect(store.run(ME)).toMatchObject({
      status: 'FAILED',
      finishedAt: new Date(NOW).toISOString(),
    });
    expect(store.groups.get('deploy-main')).toEqual({});
    expect(started).toEqual([]);
  });

  it('hands the slot to the queued run in the same group, starting it before promoting it', async () => {
    const { deps, store, started } = harness();
    store.putRun(ME, 'PENDING', 'deploy-main');
    store.putRun(WAITER, 'QUEUED', 'deploy-main');
    store.groups.set('deploy-main', { running: ME, pending: WAITER });

    const result = await recordSynthFailure(deps, { input: RUN_INPUT, synthError: JOB_FAILED }, NOW);

    expect(result).toMatchObject({ outcome: 'failed', group: 'handed-off' });
    expect(store.run(ME)?.status).toBe('FAILED');
    expect(store.run(WAITER)?.status).toBe('QUEUED');
    expect(started).toEqual([WAITER]);
    expect(store.groups.get('deploy-main')).toEqual({ running: WAITER });
  });

  it('writes the failed synth check for the workflow, owned by the run, with the cause in the summary', async () => {
    const { deps, store } = harness();
    store.putRun(ME, 'PENDING');

    await recordSynthFailure(deps, { input: RUN_INPUT, synthError: JOB_FAILED }, NOW);

    expect(store.checks).toHaveLength(1);
    const { write, nowMs } = store.checks[0];
    expect(nowMs).toBe(NOW);
    expect(checkStateKey(write.repo, write.sha, write.context)).toEqual(
      checkStateKey('octocat/app', SHA, 'deploy / synth'),
    );
    expect(write.ownerRun).toBe('deploy#1');
    expect(write.ownerRunNumber).toBe(1);
    const desired = parseDesiredCheckState(JSON.stringify(write.desired));
    expect(desired.status).toBe('completed');
    expect(desired.conclusion).toBe('failure');
    expect(desired.summary).toContain('workflows.ts:12 unknown trigger "pushh"');
    expect(desired.summary).toContain('deploy#1');
  });

  it('runs without a concurrency group touch no group slot', async () => {
    const { deps, store, started } = harness();
    store.putRun(ME, 'PENDING');
    store.groups.set('deploy-main', { running: 'octocat/app#deploy#9' });

    const result = await recordSynthFailure(deps, { input: RUN_INPUT, synthError: JOB_FAILED }, NOW);

    expect(result).toMatchObject({ outcome: 'failed', group: 'none' });
    expect(store.groups.get('deploy-main')).toEqual({ running: 'octocat/app#deploy#9' });
    expect(started).toEqual([]);
  });

  it('leaves an already-terminal run alone but still releases a slot it holds', async () => {
    const { deps, store } = harness();
    store.putRun(ME, 'CANCELLED', 'deploy-main');
    store.groups.set('deploy-main', { running: ME });

    const result = await recordSynthFailure(deps, { input: RUN_INPUT, synthError: JOB_FAILED }, NOW);

    expect(result).toMatchObject({ outcome: 'already-terminal', group: 'cleared' });
    expect(store.run(ME)?.status).toBe('CANCELLED');
    expect(store.run(ME)?.finishedAt).toBeUndefined();
    expect(store.groups.get('deploy-main')).toEqual({});
  });

  it('is a no-op for synth-only (bootstrap) executions, which have no run row', async () => {
    const { deps, store } = harness();
    const result = await recordSynthFailure(
      deps,
      { input: SYNTH_ONLY_INPUT, synthError: JOB_FAILED },
      NOW,
    );
    expect(result).toEqual({ outcome: 'skipped' });
    expect(store.checks).toEqual([]);
  });

  it('a failed group release or check write is logged, never thrown — the run stays FAILED', async () => {
    const { deps, store, logs } = harness();
    store.putRun(ME, 'PENDING', 'deploy-main');
    store.groups.set('deploy-main', { running: ME });
    store.failCheck = new Error('ThrottlingException');
    deps.store.clearRunning = async () => {
      throw new Error('ProvisionedThroughputExceededException');
    };

    const result = await recordSynthFailure(deps, { input: RUN_INPUT, synthError: JOB_FAILED }, NOW);

    expect(result).toMatchObject({ outcome: 'failed', group: 'error' });
    expect(store.run(ME)?.status).toBe('FAILED');
    expect(logs).toContain('group release failed; the sweep will repair');
    expect(logs).toContain('could not record the synth check failure');
  });

  it('rethrows a failed run-row update so the machine retries the cleanup', async () => {
    const { deps, store } = harness();
    store.putRun(ME, 'PENDING', 'deploy-main');
    store.groups.set('deploy-main', { running: ME });
    store.failFinish = new Error('ThrottlingException');

    await expect(
      recordSynthFailure(deps, { input: RUN_INPUT, synthError: JOB_FAILED }, NOW),
    ).rejects.toThrow('ThrottlingException');
    // Nothing downstream ran: the slot still belongs to the un-finished run.
    expect(store.groups.get('deploy-main')).toEqual({ running: ME });
  });
});
