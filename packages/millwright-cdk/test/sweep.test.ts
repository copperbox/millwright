import type { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import { ScanCommand } from '@aws-sdk/lib-dynamodb';
import {
  ConcurrencyGroupItem,
  RunCoordinates,
  RunItem,
  RunStatus,
  concurrencyGroupKey,
  formatRunId,
  runKey,
} from '@copperbox/millwright-state';
import { describe, expect, it } from 'vitest';
import {
  ExecutionInspector,
  ExecutionLiveness,
  carryOverExecutionName,
  runExecutionName,
} from '../src/runtime/shared/executions';
import { DynamoSweepStore } from '../src/runtime/sweep/store';
import {
  MAX_CARRY_OVER_HOPS,
  SweepDeps,
  SweepStore,
  runExecutionClosed,
  sweepGroups,
} from '../src/runtime/sweep/sweep';

const NOW = Date.parse('2026-08-12T06:00:00Z');
const SHA = 'a'.repeat(40);
const RUNNING_ID = 'octocat/app#deploy#1';
const PENDING_ID = 'octocat/app#deploy#2';

/** In-memory SweepStore mirroring the conditional-write semantics. */
class MemoryStore implements SweepStore {
  readonly groups = new Map<string, { running?: string; pending?: string }>();
  readonly runs = new Map<string, RunItem>();

  putRun(runId: string, status: RunStatus): void {
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
      concurrencyGroup: 'deploy-main',
      expiresAt: 0,
      ...(status === 'QUEUED' ? {} : { startedAt: new Date(NOW - 60_000).toISOString() }),
    });
  }

  async listGroups(): Promise<readonly ConcurrencyGroupItem[]> {
    return [...this.groups.entries()].map(([group, state]) => ({
      ...concurrencyGroupKey(group),
      ...state,
    }));
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
    const key = runKey(coords);
    const run = this.runs.get(key.pk + key.sk);
    if (!run || !['PENDING', 'QUEUED', 'RUNNING'].includes(run.status)) {
      return false;
    }
    this.runs.set(key.pk + key.sk, {
      ...run,
      status,
      finishedAt: new Date(nowMs).toISOString(),
    });
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

/**
 * Scripted execution liveness by name; anything not scripted is 'running',
 * so the pre-existing scenarios (live occupants) need no setup.
 */
class FakeExecutions implements ExecutionInspector {
  readonly byName = new Map<string, ExecutionLiveness>();
  readonly described: string[] = [];

  set(name: string, liveness: ExecutionLiveness): void {
    this.byName.set(name, liveness);
  }

  async describe(name: string): Promise<ExecutionLiveness> {
    this.described.push(name);
    return this.byName.get(name) ?? 'running';
  }
}

function runRow(runId: string): RunItem {
  const [repo, workflow, number] = runId.split('#');
  return { repo, workflow, runNumber: Number(number) } as RunItem;
}

function harness(): {
  deps: SweepDeps;
  store: MemoryStore;
  executions: FakeExecutions;
  started: string[];
} {
  const store = new MemoryStore();
  const executions = new FakeExecutions();
  const started: string[] = [];
  const deps: SweepDeps = {
    store,
    executions,
    starter: {
      startRun: async (run) => {
        started.push(formatRunId(run));
      },
    },
    log: () => {},
  };
  return { deps, store, executions, started };
}

describe('group sweep repair (spec §8.4, C16)', () => {
  it('starts the pending run of a group whose running run finished but never cleared', async () => {
    const { deps, store, started } = harness();
    // The decider died between finishRun and its release.
    store.putRun(RUNNING_ID, 'SUCCEEDED');
    store.putRun(PENDING_ID, 'QUEUED');
    store.groups.set('deploy-main', { running: RUNNING_ID, pending: PENDING_ID });

    const report = await sweepGroups(deps, NOW);
    expect(started).toEqual([PENDING_ID]);
    expect(store.groups.get('deploy-main')).toEqual({ running: PENDING_ID });
    expect(report).toMatchObject({ groups: 1, handedOff: 1, healthy: 0, cleared: 0 });
  });

  it('re-converges a crash between the hand-off start and the promote', async () => {
    const { deps, store, started } = harness();
    // The pending run's execution already started; the slots never moved.
    store.putRun(RUNNING_ID, 'FAILED');
    store.putRun(PENDING_ID, 'QUEUED');
    store.groups.set('deploy-main', { running: RUNNING_ID, pending: PENDING_ID });

    await sweepGroups(deps, NOW);
    // The re-start is harmless: the deterministic execution name dedupes it.
    expect(started).toEqual([PENDING_ID]);
    expect(store.groups.get('deploy-main')).toEqual({ running: PENDING_ID });
  });

  it('clears a stale slot with no waiter', async () => {
    const { deps, store, started } = harness();
    store.putRun(RUNNING_ID, 'CANCELLED');
    store.groups.set('deploy-main', { running: RUNNING_ID });

    const report = await sweepGroups(deps, NOW);
    expect(started).toEqual([]);
    expect(store.groups.get('deploy-main')).toEqual({});
    expect(report).toMatchObject({ cleared: 1 });
  });

  it('treats a missing run record as terminal — slots repair, executions never resurrect', async () => {
    const { deps, store, started } = harness();
    store.groups.set('deploy-main', { running: RUNNING_ID });

    const report = await sweepGroups(deps, NOW);
    expect(started).toEqual([]);
    expect(store.groups.get('deploy-main')).toEqual({});
    expect(report).toMatchObject({ cleared: 1 });
  });

  it('leaves groups with live running runs untouched', async () => {
    const { deps, store, started } = harness();
    store.putRun(RUNNING_ID, 'RUNNING');
    store.putRun(PENDING_ID, 'QUEUED');
    store.groups.set('deploy-main', { running: RUNNING_ID, pending: PENDING_ID });
    store.putRun('octocat/app#ci#5', 'QUEUED');
    store.groups.set('other', { running: 'octocat/app#ci#5' });

    const report = await sweepGroups(deps, NOW);
    expect(started).toEqual([]);
    expect(store.groups.get('deploy-main')).toEqual({
      running: RUNNING_ID,
      pending: PENDING_ID,
    });
    expect(report).toMatchObject({ groups: 2, healthy: 2, cleared: 0, handedOff: 0 });
  });

  it('skips an unparseable running id without failing the tick', async () => {
    const { deps, store } = harness();
    store.groups.set('deploy-main', { running: 'not-a-run-id' });
    store.putRun(RUNNING_ID, 'SUCCEEDED');
    store.groups.set('other', { running: RUNNING_ID });

    const report = await sweepGroups(deps, NOW);
    expect(store.groups.get('deploy-main')).toEqual({ running: 'not-a-run-id' });
    expect(report).toMatchObject({ groups: 2, cleared: 1 });
  });
});

describe('group sweep — occupants whose execution closed without a terminal run (issue #50)', () => {
  it('fails and releases a PENDING occupant whose execution closed, starting the queued waiter', async () => {
    const { deps, store, executions, started } = harness();
    // A synth failure from before the synth-failure step existed: the
    // execution ended in SynthFailed and the run row never moved.
    store.putRun(RUNNING_ID, 'PENDING');
    store.putRun(PENDING_ID, 'QUEUED');
    store.groups.set('deploy-main', { running: RUNNING_ID, pending: PENDING_ID });
    executions.set(runExecutionName(runRow(RUNNING_ID)), 'closed');
    executions.set(carryOverExecutionName(runExecutionName(runRow(RUNNING_ID))), 'missing');

    const report = await sweepGroups(deps, NOW);

    expect(store.runs.get(runKeyOf(RUNNING_ID))).toMatchObject({
      status: 'FAILED',
      finishedAt: new Date(NOW).toISOString(),
    });
    expect(started).toEqual([PENDING_ID]);
    expect(store.groups.get('deploy-main')).toEqual({ running: PENDING_ID });
    expect(report).toMatchObject({ groups: 1, failed: 1, handedOff: 1, healthy: 0 });
  });

  it('clears the slot of a RUNNING occupant whose whole carry-over chain has closed', async () => {
    const { deps, store, executions, started } = harness();
    store.putRun(RUNNING_ID, 'RUNNING');
    store.groups.set('deploy-main', { running: RUNNING_ID });
    const first = runExecutionName(runRow(RUNNING_ID));
    const second = carryOverExecutionName(first);
    executions.set(first, 'closed');
    executions.set(second, 'closed');
    executions.set(carryOverExecutionName(second), 'missing');

    const report = await sweepGroups(deps, NOW);

    expect(store.runs.get(runKeyOf(RUNNING_ID))?.status).toBe('FAILED');
    expect(started).toEqual([]);
    expect(store.groups.get('deploy-main')).toEqual({});
    expect(report).toMatchObject({ failed: 1, cleared: 1 });
  });

  it('leaves a RUNNING occupant alone when its carry-over successor is still running', async () => {
    const { deps, store, executions } = harness();
    store.putRun(RUNNING_ID, 'RUNNING');
    store.groups.set('deploy-main', { running: RUNNING_ID });
    const first = runExecutionName(runRow(RUNNING_ID));
    executions.set(first, 'closed');
    executions.set(carryOverExecutionName(first), 'running');

    const report = await sweepGroups(deps, NOW);

    expect(store.runs.get(runKeyOf(RUNNING_ID))?.status).toBe('RUNNING');
    expect(store.groups.get('deploy-main')).toEqual({ running: RUNNING_ID });
    expect(report).toMatchObject({ healthy: 1, failed: 0 });
  });

  it('leaves a PENDING occupant alone when the launcher has not started its execution yet', async () => {
    const { deps, store, executions } = harness();
    // Slot claimed, StartExecution not yet landed: the race is live, not stuck.
    store.putRun(RUNNING_ID, 'PENDING');
    store.groups.set('deploy-main', { running: RUNNING_ID });
    executions.set(runExecutionName(runRow(RUNNING_ID)), 'missing');

    const report = await sweepGroups(deps, NOW);

    expect(store.runs.get(runKeyOf(RUNNING_ID))?.status).toBe('PENDING');
    expect(store.groups.get('deploy-main')).toEqual({ running: RUNNING_ID });
    expect(report).toMatchObject({ healthy: 1, failed: 0 });
  });

  it('describes only the first execution of a live run', async () => {
    const { deps, store, executions } = harness();
    store.putRun(RUNNING_ID, 'RUNNING');
    store.groups.set('deploy-main', { running: RUNNING_ID });
    await sweepGroups(deps, NOW);
    expect(executions.described).toEqual([runExecutionName(runRow(RUNNING_ID))]);
  });

  it('terminal occupants are released without consulting Step Functions', async () => {
    const { deps, store, executions } = harness();
    store.putRun(RUNNING_ID, 'SUCCEEDED');
    store.groups.set('deploy-main', { running: RUNNING_ID });
    await sweepGroups(deps, NOW);
    expect(executions.described).toEqual([]);
    expect(store.groups.get('deploy-main')).toEqual({});
  });

  it('runExecutionClosed gives up on an implausibly long chain and calls the run live', async () => {
    const executions = new FakeExecutions();
    executions.describe = async () => 'closed';
    expect(await runExecutionClosed(executions, runRow(RUNNING_ID))).toBe(false);
    expect(MAX_CARRY_OVER_HOPS).toBeGreaterThan(3);
  });
});

function runKeyOf(runId: string): string {
  const [repo, workflow, number] = runId.split('#');
  const key = runKey({ repo, workflow, runNumber: Number(number) });
  return key.pk + key.sk;
}

describe('DynamoSweepStore.listGroups', () => {
  it('scans GROUP# rows across pagination', async () => {
    const pageOne = {
      Items: [{ ...concurrencyGroupKey('deploy-main'), running: RUNNING_ID }],
      LastEvaluatedKey: { pk: 'GROUP#deploy-main', sk: '-' },
    };
    const pageTwo = { Items: [{ ...concurrencyGroupKey('release'), running: PENDING_ID }] };
    const sent: { input: Record<string, any> }[] = [];
    const behaviors = [pageOne, pageTwo];
    const client = {
      send: async (command: { input: Record<string, any> }) => {
        sent.push({ input: command.input });
        expect(command).toBeInstanceOf(ScanCommand);
        return behaviors.shift();
      },
    } as unknown as DynamoDBDocumentClient;

    const store = new DynamoSweepStore(client, 'table', 90);
    const groups = await store.listGroups();
    expect(groups.map((g) => g.pk)).toEqual(['GROUP#deploy-main', 'GROUP#release']);
    expect(sent[0].input.FilterExpression).toBe('begins_with(pk, :group)');
    expect(sent[0].input.ExpressionAttributeValues).toEqual({ ':group': 'GROUP#' });
    expect(sent[1].input.ExclusiveStartKey).toEqual({ pk: 'GROUP#deploy-main', sk: '-' });
  });
});
