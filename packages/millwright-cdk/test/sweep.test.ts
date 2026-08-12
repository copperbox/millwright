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
import { DynamoSweepStore } from '../src/runtime/sweep/store';
import { SweepDeps, SweepStore, sweepGroups } from '../src/runtime/sweep/sweep';

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

function harness(): { deps: SweepDeps; store: MemoryStore; started: string[] } {
  const store = new MemoryStore();
  const started: string[] = [];
  const deps: SweepDeps = {
    store,
    starter: {
      startRun: async (run) => {
        started.push(formatRunId(run));
      },
    },
    log: () => {},
  };
  return { deps, store, started };
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
