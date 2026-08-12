import type { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import { GetCommand, ScanCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb';
import { checkStateKey } from '@copperbox/millwright-state';
import { describe, expect, it } from 'vitest';
import { DynamoReporterStore } from '../src/runtime/reporter/store';

const SHA = 'a'.repeat(40);
const COORDS = { repo: 'octocat/app', sha: SHA, context: 'ci / build' };
const KEY = checkStateKey(COORDS.repo, COORDS.sha, COORDS.context);

type Sent = { command: unknown; input: Record<string, any> };

function fakeClient(behaviors: Array<{ result?: unknown; error?: Error }>): {
  client: DynamoDBDocumentClient;
  sent: Sent[];
} {
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

function conditionalFailure(): Error {
  return Object.assign(new Error('conditional'), { name: 'ConditionalCheckFailedException' });
}

describe('getCheck', () => {
  it('reads the item with a consistent read', async () => {
    const { client, sent } = fakeClient([{ result: { Item: { ...KEY } } }]);
    const store = new DynamoReporterStore(client, 'table');
    const item = await store.getCheck(COORDS);
    expect(item).toEqual(KEY);
    expect(sent[0].command).toBeInstanceOf(GetCommand);
    expect(sent[0].input).toMatchObject({ TableName: 'table', Key: KEY, ConsistentRead: true });
  });
});

describe('markReported', () => {
  it('writes reported + checkRunId and clears backoff, conditional on desired unchanged', async () => {
    const { client, sent } = fakeClient([{}]);
    const store = new DynamoReporterStore(client, 'table');
    const outcome = await store.markReported(COORDS, '{"seen":1}', 777);
    expect(outcome).toBe('applied');
    expect(sent[0].command).toBeInstanceOf(UpdateCommand);
    expect(sent[0].input.ConditionExpression).toBe('desired = :seenDesired');
    expect(sent[0].input.UpdateExpression).toMatch(/reported = :reported/);
    expect(sent[0].input.UpdateExpression).toMatch(/checkRunId = :checkRunId/);
    expect(sent[0].input.UpdateExpression).toMatch(/REMOVE backoffAttempts, nextAttemptAt/);
    expect(sent[0].input.ExpressionAttributeValues).toMatchObject({
      ':reported': '{"seen":1}',
      ':seenDesired': '{"seen":1}',
      ':checkRunId': 777,
    });
  });

  it('omits checkRunId in PAT mode (statuses have no run id)', async () => {
    const { client, sent } = fakeClient([{}]);
    const store = new DynamoReporterStore(client, 'table');
    await store.markReported(COORDS, '{"seen":1}');
    expect(sent[0].input.UpdateExpression).not.toMatch(/checkRunId/);
  });

  it('returns stale when a newer desired state landed mid-flight', async () => {
    const { client } = fakeClient([{ error: conditionalFailure() }]);
    const store = new DynamoReporterStore(client, 'table');
    expect(await store.markReported(COORDS, '{"seen":1}', 777)).toBe('stale');
  });
});

describe('failure and abandonment writes', () => {
  it('records backoff state onto an existing item and swallows a vanished item', async () => {
    const { client, sent } = fakeClient([{}, { error: conditionalFailure() }]);
    const store = new DynamoReporterStore(client, 'table');
    await store.recordAttemptFailure(COORDS, 3, '2026-08-12T06:15:00.000Z');
    expect(sent[0].input.ConditionExpression).toBe('attribute_exists(pk)');
    expect(sent[0].input.ExpressionAttributeValues).toMatchObject({
      ':backoffAttempts': 3,
      ':nextAttemptAt': '2026-08-12T06:15:00.000Z',
    });
    await expect(store.recordAttemptFailure(COORDS, 4, 'x')).resolves.toBeUndefined();
  });

  it('marks abandonment and records check-run ids the same way', async () => {
    const { client, sent } = fakeClient([{}, {}]);
    const store = new DynamoReporterStore(client, 'table');
    await store.markAbandoned(COORDS);
    expect(sent[0].input.UpdateExpression).toMatch(/abandoned = :abandoned/);
    expect(sent[0].input.ExpressionAttributeValues[':abandoned']).toBe(true);
    await store.recordCheckRunId(COORDS, 888);
    expect(sent[1].input.ExpressionAttributeValues[':checkRunId']).toBe(888);
    expect(sent[1].input.ConditionExpression).toBe('attribute_exists(pk)');
  });
});

describe('listUnconverged', () => {
  it('scans CHECK# items with a desired that is unreported and not abandoned, following pagination', async () => {
    const first = { ...KEY, context: 'ci / build' };
    const second = { ...KEY, sk: 'CTX#ci / test', context: 'ci / test' };
    const { client, sent } = fakeClient([
      { result: { Items: [first], LastEvaluatedKey: KEY } },
      { result: { Items: [second] } },
    ]);
    const store = new DynamoReporterStore(client, 'table');
    const items = await store.listUnconverged();
    expect(items).toEqual([first, second]);
    expect(sent[0].command).toBeInstanceOf(ScanCommand);
    const filter = sent[0].input.FilterExpression as string;
    expect(filter).toContain('begins_with(pk, :checkPrefix)');
    expect(filter).toContain('attribute_exists(desired)');
    expect(filter).toContain('attribute_not_exists(abandoned)');
    expect(filter).toContain('attribute_not_exists(reported) OR reported <> desired');
    expect(sent[1].input.ExclusiveStartKey).toEqual(KEY);
  });
});
