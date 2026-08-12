import type { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import {
  GetCommand,
  PutCommand,
  TransactWriteCommand,
  UpdateCommand,
} from '@aws-sdk/lib-dynamodb';
import { RunItem, runKey, withMetadataTtl } from '@copperbox/millwright-state';
import { describe, expect, it } from 'vitest';
import { DynamoLauncherStore } from '../src/runtime/launcher/store';

const NOW = Date.parse('2026-08-12T06:00:00Z');
const IDENTITY = {
  repo: 'octocat/app',
  ref: 'refs/heads/main',
  sha: 'c'.repeat(40),
  kind: 'push',
} as const;

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

function namedError(name: string, extra: Record<string, unknown> = {}): Error {
  return Object.assign(new Error(name), { name }, extra);
}

function transactionCanceled(codes: string[]): Error {
  return namedError('TransactionCanceledException', {
    CancellationReasons: codes.map((code) => ({ Code: code })),
  });
}

function run(runNumber: number): RunItem {
  const coords = { repo: 'octocat/app', workflow: 'ci', runNumber };
  const createdAt = new Date(NOW).toISOString();
  return withMetadataTtl(
    {
      ...runKey(coords),
      ...coords,
      status: 'PENDING',
      trigger: 'push',
      ref: 'refs/heads/main',
      sha: 'c'.repeat(40),
      createdAt,
      originalStartedAt: createdAt,
    },
    NOW,
  );
}

describe('claimEvent', () => {
  it('conditionally puts a fresh processing record with an empty runIds map', async () => {
    const { client, sent } = fakeClient([{}]);
    const store = new DynamoLauncherStore(client, 'table', 90);
    const claim = await store.claimEvent(IDENTITY, NOW);
    expect(claim).toEqual({ created: true, runIds: {} });
    expect(sent[0].command).toBeInstanceOf(PutCommand);
    expect(sent[0].input.ConditionExpression).toBe('attribute_not_exists(pk)');
    expect(sent[0].input.Item).toMatchObject({
      runIds: {},
      expiresAt: Math.floor(NOW / 1000) + 30 * 60,
    });
  });

  it('falls back to a consistent read of the existing record on condition failure', async () => {
    const { client, sent } = fakeClient([
      { error: namedError('ConditionalCheckFailedException') },
      { result: { Item: { runIds: { ci: 'octocat/app#ci#7' } } } },
    ]);
    const store = new DynamoLauncherStore(client, 'table', 90);
    const claim = await store.claimEvent(IDENTITY, NOW);
    expect(claim).toEqual({ created: false, runIds: { ci: 'octocat/app#ci#7' } });
    expect(sent[1].command).toBeInstanceOf(GetCommand);
    expect(sent[1].input.ConsistentRead).toBe(true);
  });
});

describe('nextRunNumber', () => {
  it('atomically increments and returns the new value', async () => {
    const { client, sent } = fakeClient([{ result: { Attributes: { value: 142 } } }]);
    const store = new DynamoLauncherStore(client, 'table', 90);
    expect(await store.nextRunNumber('octocat/app', 'ci', NOW)).toBe(142);
    expect(sent[0].command).toBeInstanceOf(UpdateCommand);
    expect(sent[0].input.UpdateExpression).toContain('ADD #value :one');
  });

  it('fails loudly on a non-numeric counter', async () => {
    const { client } = fakeClient([{ result: { Attributes: { value: 'x' } } }]);
    const store = new DynamoLauncherStore(client, 'table', 90);
    await expect(store.nextRunNumber('octocat/app', 'ci', NOW)).rejects.toThrow(/counter/i);
  });
});

describe('createRun', () => {
  it('puts the run and records it on the processing record in one transaction', async () => {
    const { client, sent } = fakeClient([{}]);
    const store = new DynamoLauncherStore(client, 'table', 90);
    expect(await store.createRun(run(1), IDENTITY, NOW)).toBe(true);
    expect(sent[0].command).toBeInstanceOf(TransactWriteCommand);
    const [putItem, updateItem] = sent[0].input.TransactItems;
    expect(putItem.Put.ConditionExpression).toBe('attribute_not_exists(pk)');
    expect(updateItem.Update.ConditionExpression).toContain(
      'attribute_not_exists(#runIds.#workflow)',
    );
    expect(updateItem.Update.ExpressionAttributeValues[':runId']).toBe('octocat/app#ci#1');
  });

  it('returns false when a concurrent delivery recorded the run first', async () => {
    const { client } = fakeClient([
      { error: transactionCanceled(['None', 'ConditionalCheckFailed']) },
    ]);
    const store = new DynamoLauncherStore(client, 'table', 90);
    expect(await store.createRun(run(1), IDENTITY, NOW)).toBe(false);
  });

  it('throws hard when the run record already exists (number reuse)', async () => {
    const { client } = fakeClient([
      { error: transactionCanceled(['ConditionalCheckFailed', 'None']) },
    ]);
    const store = new DynamoLauncherStore(client, 'table', 90);
    await expect(store.createRun(run(1), IDENTITY, NOW)).rejects.toThrow(/reused/);
  });

  it('rethrows transient transaction conflicts for the delivery to retry', async () => {
    const { client } = fakeClient([
      { error: transactionCanceled(['TransactionConflict', 'None']) },
    ]);
    const store = new DynamoLauncherStore(client, 'table', 90);
    await expect(store.createRun(run(1), IDENTITY, NOW)).rejects.toThrow(
      'TransactionCanceledException',
    );
  });
});

describe('group claims', () => {
  it('claimRunningSlot returns false when the slot is held by another run', async () => {
    const { client, sent } = fakeClient([
      { error: namedError('ConditionalCheckFailedException') },
    ]);
    const store = new DynamoLauncherStore(client, 'table', 90);
    expect(await store.claimRunningSlot('deploy', 'octocat/app#ci#2', NOW)).toBe(false);
    expect(sent[0].input.ConditionExpression).toBe(
      'attribute_not_exists(#running) OR #running = :me',
    );
  });

  it('claimPendingSlot conditions on the observed group state and marks the run QUEUED', async () => {
    const { client, sent } = fakeClient([{}]);
    const store = new DynamoLauncherStore(client, 'table', 90);
    const ok = await store.claimPendingSlot(
      'deploy',
      'octocat/app#ci#3',
      {
        expectedRunning: 'octocat/app#ci#1',
        expectedPending: 'octocat/app#ci#2',
        markQueued: { repo: 'octocat/app', workflow: 'ci', runNumber: 3 },
        cancelReplaced: { repo: 'octocat/app', workflow: 'ci', runNumber: 2 },
        requestCancelOf: { repo: 'octocat/app', workflow: 'ci', runNumber: 1 },
      },
      NOW,
    );
    expect(ok).toBe(true);
    const items = sent[0].input.TransactItems;
    expect(items).toHaveLength(4);
    expect(items[0].Update.ConditionExpression).toBe(
      '#running = :expectedRunning AND #pending = :expectedPending',
    );
    expect(items[1].Update.ExpressionAttributeValues).toEqual({
      ':queued': 'QUEUED',
      ':pending': 'PENDING',
    });
    expect(items[2].Update.ExpressionAttributeValues[':superseded']).toBe('superseded');
    expect(items[3].Update.UpdateExpression).toBe('SET cancelRequested = :true');
  });

  it('claimPendingSlot requires an empty pending slot when none was observed', async () => {
    const { client, sent } = fakeClient([{ error: transactionCanceled(['ConditionalCheckFailed']) }]);
    const store = new DynamoLauncherStore(client, 'table', 90);
    const ok = await store.claimPendingSlot(
      'deploy',
      'octocat/app#ci#2',
      {
        expectedRunning: 'octocat/app#ci#1',
        markQueued: { repo: 'octocat/app', workflow: 'ci', runNumber: 2 },
      },
      NOW,
    );
    expect(ok).toBe(false);
    expect(sent[0].input.TransactItems[0].Update.ConditionExpression).toBe(
      '#running = :expectedRunning AND attribute_not_exists(#pending)',
    );
    expect(sent[0].input.TransactItems).toHaveLength(2);
  });
});
