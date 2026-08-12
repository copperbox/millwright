import type { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import { UpdateCommand } from '@aws-sdk/lib-dynamodb';
import { ValidStepEvent } from '@copperbox/millwright-state';
import { describe, expect, it } from 'vitest';
import { DynamoStepEventsStore } from '../src/runtime/step-events/store';

const NOW = Date.parse('2026-08-12T06:00:00Z');
const RETENTION_DAYS = 90;

const EVENT: ValidStepEvent = {
  coords: { repo: 'octo/app', workflow: 'ci', runNumber: 7 },
  job: 'build',
  stepIndex: 1,
  status: 'RUNNING',
  name: 'compile',
  startedAt: '2026-08-12T06:00:00.000Z',
};

type Sent = { command: unknown; input: Record<string, any> };

function fakeClient(behaviors: Array<{ error?: Error }> = [{}]): {
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
      return {};
    },
  } as unknown as DynamoDBDocumentClient;
  return { client, sent };
}

describe('DynamoStepEventsStore', () => {
  it('upserts the row under the step key with identity, TTL and present fields', async () => {
    const { client, sent } = fakeClient();
    const store = new DynamoStepEventsStore(client, 'state', RETENTION_DAYS);
    expect(await store.writeStepRow(EVENT, NOW)).toBe('written');

    expect(sent).toHaveLength(1);
    expect(sent[0].command).toBeInstanceOf(UpdateCommand);
    const input = sent[0].input;
    expect(input.TableName).toBe('state');
    expect(input.Key).toEqual({ pk: 'RUN#octo/app#ci#7', sk: 'JOB#build#STEP#0001' });
    expect(input.ExpressionAttributeValues).toMatchObject({
      ':status': 'RUNNING',
      ':repo': 'octo/app',
      ':workflow': 'ci',
      ':runNumber': 7,
      ':job': 'build',
      ':stepIndex': 1,
      ':name': 'compile',
      ':startedAt': '2026-08-12T06:00:00.000Z',
      ':expiresAt': Math.floor(NOW / 1000) + RETENTION_DAYS * 24 * 60 * 60,
    });
    // Absent optionals never reach the expression: a terminal write later
    // must not have to clear placeholder attributes.
    expect(input.UpdateExpression).not.toContain('finishedAt');
    expect(input.UpdateExpression).not.toContain('reason');
  });

  it('fences RUNNING writes on the row not already being terminal', async () => {
    const { client, sent } = fakeClient();
    await new DynamoStepEventsStore(client, 'state', RETENTION_DAYS).writeStepRow(EVENT, NOW);
    expect(sent[0].input.ConditionExpression).toBe(
      'attribute_not_exists(pk) OR #status = :status',
    );
  });

  it('reports superseded when the RUNNING fence trips', async () => {
    const err = Object.assign(new Error('conditional'), {
      name: 'ConditionalCheckFailedException',
    });
    const { client } = fakeClient([{ error: err }]);
    const store = new DynamoStepEventsStore(client, 'state', RETENTION_DAYS);
    expect(await store.writeStepRow(EVENT, NOW)).toBe('superseded');
  });

  it('writes terminal statuses unconditionally — duplicates converge on the same row', async () => {
    const { client, sent } = fakeClient();
    const store = new DynamoStepEventsStore(client, 'state', RETENTION_DAYS);
    await store.writeStepRow(
      {
        ...EVENT,
        status: 'SKIPPED',
        reason: 'skip_if',
        finishedAt: '2026-08-12T06:00:01.000Z',
      },
      NOW,
    );
    const input = sent[0].input;
    expect(input.ConditionExpression).toBeUndefined();
    expect(input.ExpressionAttributeValues).toMatchObject({
      ':status': 'SKIPPED',
      ':reason': 'skip_if',
      ':finishedAt': '2026-08-12T06:00:01.000Z',
    });
  });

  it('propagates non-conditional errors', async () => {
    const { client } = fakeClient([{ error: new Error('throttled') }]);
    const store = new DynamoStepEventsStore(client, 'state', RETENTION_DAYS);
    await expect(store.writeStepRow(EVENT, NOW)).rejects.toThrow('throttled');
  });
});
