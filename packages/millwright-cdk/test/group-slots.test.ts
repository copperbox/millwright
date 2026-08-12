import type { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import { GetCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb';
import { describe, expect, it } from 'vitest';
import {
  DynamoGroupSlotStore,
  GroupReleaseDeps,
  releaseGroupSlot,
} from '../src/runtime/shared/groups';

const NOW = Date.parse('2026-08-12T06:00:00Z');
const GROUP = 'deploy-main';
const ME = 'octocat/app#deploy#1';
const WAITER = 'octocat/app#deploy#2';

type Sent = { command: unknown; input: Record<string, any> };

/** Scripted DocumentClient: each call shifts the next behavior. */
function fakeClient(
  behaviors: Array<{ result?: unknown; error?: Error }>,
): { client: DynamoDBDocumentClient; sent: Sent[] } {
  const sent: Sent[] = [];
  const client = {
    send: async (command: { input: Record<string, any> }) => {
      sent.push({ command, input: command.input });
      const behavior = behaviors.shift() ?? {};
      if (behavior.error) {
        throw behavior.error;
      }
      return behavior.result ?? {};
    },
  } as unknown as DynamoDBDocumentClient;
  return { client, sent };
}

function namedError(name: string): Error {
  return Object.assign(new Error(name), { name });
}

describe('DynamoGroupSlotStore', () => {
  it('reads the group with a consistent read', async () => {
    const { client, sent } = fakeClient([
      { result: { Item: { pk: `GROUP#${GROUP}`, sk: '-', running: ME } } },
    ]);
    const store = new DynamoGroupSlotStore(client, 'table', 90);
    const state = await store.getGroup(GROUP);
    expect(state?.running).toBe(ME);
    expect(sent[0].command).toBeInstanceOf(GetCommand);
    expect(sent[0].input).toMatchObject({
      Key: { pk: `GROUP#${GROUP}`, sk: '-' },
      ConsistentRead: true,
    });
  });

  it('promotes the pending run conditioned on the exact slots just read', async () => {
    const { client, sent } = fakeClient([{}]);
    const store = new DynamoGroupSlotStore(client, 'table', 90);
    expect(await store.promotePending(GROUP, { running: ME, pending: WAITER }, NOW)).toBe(true);
    expect(sent[0].command).toBeInstanceOf(UpdateCommand);
    expect(sent[0].input.UpdateExpression).toBe(
      'SET #running = :pending, #ttl = :expiresAt REMOVE #pending',
    );
    expect(sent[0].input.ConditionExpression).toBe('#running = :running AND #pending = :pending');
    expect(sent[0].input.ExpressionAttributeValues).toMatchObject({
      ':running': ME,
      ':pending': WAITER,
    });
  });

  it('clears the running slot only while it is still ours and no waiter exists', async () => {
    const { client, sent } = fakeClient([{}]);
    const store = new DynamoGroupSlotStore(client, 'table', 90);
    expect(await store.clearRunning(GROUP, ME)).toBe(true);
    expect(sent[0].input.UpdateExpression).toBe('REMOVE #running');
    expect(sent[0].input.ConditionExpression).toBe(
      '#running = :running AND attribute_not_exists(#pending)',
    );
  });

  it('returns false on a lost condition and rethrows anything else', async () => {
    const failed = fakeClient([{ error: namedError('ConditionalCheckFailedException') }]);
    const store = new DynamoGroupSlotStore(failed.client, 'table', 90);
    expect(await store.clearRunning(GROUP, ME)).toBe(false);

    const throttled = fakeClient([{ error: namedError('ThrottlingException') }]);
    const throttledStore = new DynamoGroupSlotStore(throttled.client, 'table', 90);
    await expect(
      throttledStore.promotePending(GROUP, { running: ME, pending: WAITER }, NOW),
    ).rejects.toThrow('ThrottlingException');
  });
});

/** In-memory GroupSlotStore mirroring the conditional-write semantics. */
function memoryDeps(
  groups: Map<string, { running?: string; pending?: string }>,
  runs: Map<string, { status: string }>,
): GroupReleaseDeps & { started: string[] } {
  const started: string[] = [];
  return {
    started,
    store: {
      getGroup: async (group) => {
        const state = groups.get(group);
        return state ? ({ pk: `GROUP#${group}`, sk: '-', ...state } as never) : undefined;
      },
      getRun: async (coords) => {
        const id = `${coords.repo}#${coords.workflow}#${coords.runNumber}`;
        return runs.get(id) ? ({ ...runs.get(id), runNumber: coords.runNumber } as never) : undefined;
      },
      promotePending: async (group, expected) => {
        const state = groups.get(group);
        if (state?.running !== expected.running || state?.pending !== expected.pending) {
          return false;
        }
        groups.set(group, { running: expected.pending });
        return true;
      },
      clearRunning: async (group, expectedRunning) => {
        const state = groups.get(group);
        if (state?.running !== expectedRunning || state.pending !== undefined) {
          return false;
        }
        groups.set(group, {});
        return true;
      },
      dropPending: async (group, expected) => {
        const state = groups.get(group);
        if (state?.running !== expected.running || state?.pending !== expected.pending) {
          return false;
        }
        groups.set(group, { running: state.running });
        return true;
      },
    },
    starter: {
      startRun: async (run) => {
        started.push(`octocat/app#deploy#${run.runNumber}`);
      },
    },
    log: () => {},
  };
}

describe('releaseGroupSlot', () => {
  it('starts the waiter BEFORE promoting it, so a crash between the two is sweep-repairable', async () => {
    const groups = new Map([[GROUP, { running: ME, pending: WAITER }]]);
    const runs = new Map([[WAITER, { status: 'QUEUED' }]]);
    const deps = memoryDeps(groups, runs);
    const order: string[] = [];
    const startRun = deps.starter.startRun;
    const promote = deps.store.promotePending;
    deps.starter.startRun = async (run) => {
      order.push('start');
      return startRun(run);
    };
    deps.store.promotePending = async (group, expected, nowMs) => {
      order.push('promote');
      return promote(group, expected, nowMs);
    };

    expect(await releaseGroupSlot(deps, GROUP, ME, NOW)).toBe('handed-off');
    expect(order).toEqual(['start', 'promote']);
    expect(groups.get(GROUP)).toEqual({ running: WAITER });
    expect(deps.started).toEqual([WAITER]);
  });

  it('returns not-held without writing when the slot belongs to someone else', async () => {
    const groups = new Map([[GROUP, { running: WAITER }]]);
    const deps = memoryDeps(groups, new Map());
    expect(await releaseGroupSlot(deps, GROUP, ME, NOW)).toBe('not-held');
    expect(groups.get(GROUP)).toEqual({ running: WAITER });
  });

  it('hands off to a waiter that arrives between the read and the clear', async () => {
    const groups = new Map<string, { running?: string; pending?: string }>([
      [GROUP, { running: ME }],
    ]);
    const runs = new Map([[WAITER, { status: 'QUEUED' }]]);
    const deps = memoryDeps(groups, runs);
    // The launcher wins the race: a pending claim lands after our read.
    const clear = deps.store.clearRunning;
    deps.store.clearRunning = async (group, expectedRunning) => {
      groups.set(group, { running: ME, pending: WAITER });
      return clear(group, expectedRunning);
    };

    expect(await releaseGroupSlot(deps, GROUP, ME, NOW)).toBe('handed-off');
    expect(groups.get(GROUP)).toEqual({ running: WAITER });
    expect(deps.started).toEqual([WAITER]);
  });

  it('reports contention after bounded attempts instead of spinning', async () => {
    const groups = new Map([[GROUP, { running: ME }]]);
    const deps = memoryDeps(groups, new Map());
    let attempts = 0;
    deps.store.clearRunning = async () => {
      attempts++;
      return false;
    };
    expect(await releaseGroupSlot(deps, GROUP, ME, NOW)).toBe('contended');
    expect(attempts).toBe(5);
  });
});
