import {
  ConcurrencyGroupItem,
  EVENT_DEDUPE_TTL_SECONDS,
  EventDedupeItem,
  EventIdentity,
  RegistryItem,
  RunCoordinates,
  RunItem,
  concurrencyGroupKey,
  eventDedupeKey,
  expiresAtAfterDays,
  expiresAtAfterSeconds,
  formatRunId,
  registryKey,
  runCounterKey,
  runKey,
} from '@copperbox/millwright-state';
import type { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import {
  GetCommand,
  PutCommand,
  TransactWriteCommand,
  UpdateCommand,
} from '@aws-sdk/lib-dynamodb';
import { LauncherStore } from './launcher';

/**
 * The launcher's state-table access (spec §7.8 write partition: counter, run
 * create, dedupe/processing records, group claims). Everything that must be
 * exactly-once is a conditional or transactional write; reads that feed
 * conditions are strongly consistent.
 */
export class DynamoLauncherStore implements LauncherStore {
  constructor(
    private readonly client: DynamoDBDocumentClient,
    private readonly tableName: string,
    private readonly metadataRetentionDays: number,
  ) {}

  async claimEvent(
    identity: EventIdentity,
    nowMs: number,
  ): Promise<{ created: boolean; runIds: Readonly<Record<string, string>> }> {
    const key = eventDedupeKey(identity);
    const record: EventDedupeItem = {
      ...key,
      runIds: {},
      expiresAt: expiresAtAfterSeconds(nowMs, EVENT_DEDUPE_TTL_SECONDS),
    };
    try {
      await this.client.send(
        new PutCommand({
          TableName: this.tableName,
          Item: record,
          ConditionExpression: 'attribute_not_exists(pk)',
        }),
      );
      return { created: true, runIds: {} };
    } catch (err) {
      if (!isConditionalCheckFailure(err)) {
        throw err;
      }
    }
    const existing = await this.client.send(
      new GetCommand({ TableName: this.tableName, Key: key, ConsistentRead: true }),
    );
    return {
      created: false,
      runIds: (existing.Item as EventDedupeItem | undefined)?.runIds ?? {},
    };
  }

  async getRegistryEntry(repo: string, ref: string): Promise<RegistryItem | undefined> {
    const result = await this.client.send(
      new GetCommand({ TableName: this.tableName, Key: registryKey(repo, ref) }),
    );
    return result.Item as RegistryItem | undefined;
  }

  async nextRunNumber(repo: string, workflow: string, nowMs: number): Promise<number> {
    const result = await this.client.send(
      new UpdateCommand({
        TableName: this.tableName,
        Key: runCounterKey(repo, workflow),
        UpdateExpression: 'ADD #value :one SET #ttl = :expiresAt',
        ExpressionAttributeNames: { '#value': 'value', '#ttl': 'expiresAt' },
        ExpressionAttributeValues: {
          ':one': 1,
          ':expiresAt': expiresAtAfterDays(nowMs, this.metadataRetentionDays),
        },
        ReturnValues: 'UPDATED_NEW',
      }),
    );
    const value = result.Attributes?.value;
    if (typeof value !== 'number' || !Number.isInteger(value) || value < 1) {
      throw new Error(`Run counter for ${repo}/${workflow} returned ${String(value)}`);
    }
    return value;
  }

  async createRun(run: RunItem, identity: EventIdentity, nowMs: number): Promise<boolean> {
    const eventKey = eventDedupeKey(identity);
    try {
      await this.client.send(
        new TransactWriteCommand({
          TransactItems: [
            {
              Put: {
                TableName: this.tableName,
                Item: run,
                // A run number is never reused; an existing record here means
                // the counter went backwards and must fail loudly.
                ConditionExpression: 'attribute_not_exists(pk)',
              },
            },
            {
              Update: {
                TableName: this.tableName,
                Key: eventKey,
                UpdateExpression: 'SET #runIds.#workflow = :runId, #ttl = :expiresAt',
                ConditionExpression:
                  'attribute_exists(pk) AND attribute_not_exists(#runIds.#workflow)',
                ExpressionAttributeNames: {
                  '#runIds': 'runIds',
                  '#workflow': run.workflow,
                  '#ttl': 'expiresAt',
                },
                ExpressionAttributeValues: {
                  ':runId': formatRunId(run),
                  ':expiresAt': expiresAtAfterSeconds(nowMs, EVENT_DEDUPE_TTL_SECONDS),
                },
              },
            },
          ],
        }),
      );
      return true;
    } catch (err) {
      const reasons = cancellationReasons(err);
      if (!reasons) {
        throw err;
      }
      if (reasons[0] === 'ConditionalCheckFailed') {
        throw new Error(
          `Run record ${formatRunId(run)} already exists — the counter allocated a reused number`,
        );
      }
      if (reasons[1] === 'ConditionalCheckFailed') {
        // The processing record already names a run for this workflow: a
        // concurrent delivery won. The caller adopts that run.
        return false;
      }
      throw err; // transient transaction conflict — the delivery retries
    }
  }

  async getRun(coords: RunCoordinates): Promise<RunItem | undefined> {
    const result = await this.client.send(
      new GetCommand({
        TableName: this.tableName,
        Key: runKey(coords),
        ConsistentRead: true,
      }),
    );
    return result.Item as RunItem | undefined;
  }

  async getGroup(group: string): Promise<ConcurrencyGroupItem | undefined> {
    const result = await this.client.send(
      new GetCommand({
        TableName: this.tableName,
        Key: concurrencyGroupKey(group),
        ConsistentRead: true,
      }),
    );
    return result.Item as ConcurrencyGroupItem | undefined;
  }

  async claimRunningSlot(group: string, runId: string, nowMs: number): Promise<boolean> {
    try {
      await this.client.send(
        new UpdateCommand({
          TableName: this.tableName,
          Key: concurrencyGroupKey(group),
          UpdateExpression: 'SET #running = :me, #ttl = :expiresAt',
          ConditionExpression: 'attribute_not_exists(#running) OR #running = :me',
          ExpressionAttributeNames: { '#running': 'running', '#ttl': 'expiresAt' },
          ExpressionAttributeValues: {
            ':me': runId,
            ':expiresAt': expiresAtAfterDays(nowMs, this.metadataRetentionDays),
          },
        }),
      );
      return true;
    } catch (err) {
      if (isConditionalCheckFailure(err)) {
        return false;
      }
      throw err;
    }
  }

  async claimPendingSlot(
    group: string,
    runId: string,
    opts: {
      readonly expectedRunning: string;
      readonly expectedPending?: string;
      readonly markQueued: RunCoordinates;
      readonly cancelReplaced?: RunCoordinates;
      readonly requestCancelOf?: RunCoordinates;
    },
    nowMs: number,
  ): Promise<boolean> {
    const finishedAt = new Date(nowMs).toISOString();
    const transactItems: NonNullable<
      ConstructorParameters<typeof TransactWriteCommand>[0]['TransactItems']
    > = [
      {
        Update: {
          TableName: this.tableName,
          Key: concurrencyGroupKey(group),
          UpdateExpression: 'SET #pending = :me, #ttl = :expiresAt',
          ConditionExpression: opts.expectedPending
            ? '#running = :expectedRunning AND #pending = :expectedPending'
            : '#running = :expectedRunning AND attribute_not_exists(#pending)',
          ExpressionAttributeNames: {
            '#running': 'running',
            '#pending': 'pending',
            '#ttl': 'expiresAt',
          },
          ExpressionAttributeValues: {
            ':me': runId,
            ':expectedRunning': opts.expectedRunning,
            ':expiresAt': expiresAtAfterDays(nowMs, this.metadataRetentionDays),
            ...(opts.expectedPending ? { ':expectedPending': opts.expectedPending } : {}),
          },
        },
      },
      {
        Update: {
          TableName: this.tableName,
          Key: runKey(opts.markQueued),
          UpdateExpression: 'SET #status = :queued',
          ConditionExpression: '#status = :pending',
          ExpressionAttributeNames: { '#status': 'status' },
          ExpressionAttributeValues: { ':queued': 'QUEUED', ':pending': 'PENDING' },
        },
      },
    ];
    if (opts.cancelReplaced) {
      transactItems.push({
        Update: {
          TableName: this.tableName,
          Key: runKey(opts.cancelReplaced),
          UpdateExpression: 'SET #status = :cancelled, #reason = :superseded, finishedAt = :now',
          ConditionExpression: '#status = :queued',
          ExpressionAttributeNames: { '#status': 'status', '#reason': 'reason' },
          ExpressionAttributeValues: {
            ':cancelled': 'CANCELLED',
            ':superseded': 'superseded',
            ':queued': 'QUEUED',
            ':now': finishedAt,
          },
        },
      });
    }
    if (opts.requestCancelOf) {
      transactItems.push({
        Update: {
          TableName: this.tableName,
          Key: runKey(opts.requestCancelOf),
          UpdateExpression: 'SET cancelRequested = :true',
          ConditionExpression: 'attribute_exists(pk)',
          ExpressionAttributeValues: { ':true': true },
        },
      });
    }
    try {
      await this.client.send(new TransactWriteCommand({ TransactItems: transactItems }));
      return true;
    } catch (err) {
      if (cancellationReasons(err)) {
        return false; // stale read of the group — the caller re-reads and retries
      }
      throw err;
    }
  }
}

function isConditionalCheckFailure(err: unknown): boolean {
  return (err as { name?: string })?.name === 'ConditionalCheckFailedException';
}

/** The per-item cancellation codes of a failed transaction, or undefined. */
function cancellationReasons(err: unknown): string[] | undefined {
  const e = err as { name?: string; CancellationReasons?: { Code?: string }[] };
  if (e?.name !== 'TransactionCanceledException') {
    return undefined;
  }
  return (e.CancellationReasons ?? []).map((reason) => reason.Code ?? 'None');
}
