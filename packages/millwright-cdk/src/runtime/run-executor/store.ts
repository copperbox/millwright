import {
  BuildMappingItem,
  JobItem,
  RunCoordinates,
  RunItem,
  buildMappingKey,
  expiresAtAfterDays,
  jobKey,
  runKey,
} from '@copperbox/millwright-state';
import type { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import { GetCommand, TransactWriteCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb';
import {
  JobProjectionPatch,
  isConditionalCheckFailure,
  jobProjectionUpdate,
  queryJobRows,
} from '../shared/jobs';
import { DeciderStore } from './iteration';

/**
 * The decider's state-table access (spec §7.8 write partition: run + job
 * rows, `BUILD#` items). Dispatch claims are conditional on the exact
 * attempt count and terminal transitions on a live status, so concurrent
 * iterations — possible when a wake lands while a decider is still running —
 * can never double-dispatch an attempt or resurrect a finished run.
 */
export class DynamoDeciderStore implements DeciderStore {
  constructor(
    private readonly client: DynamoDBDocumentClient,
    private readonly tableName: string,
    private readonly metadataRetentionDays: number,
  ) {}

  async getRun(coords: RunCoordinates): Promise<RunItem | undefined> {
    const result = await this.client.send(
      new GetCommand({ TableName: this.tableName, Key: runKey(coords), ConsistentRead: true }),
    );
    return result.Item as RunItem | undefined;
  }

  async beginIteration(
    coords: RunCoordinates,
    taskToken: string,
    opts: { readonly markStarted: boolean },
    nowMs: number,
  ): Promise<'ok' | 'terminal'> {
    const nowIso = new Date(nowMs).toISOString();
    try {
      await this.client.send(
        new UpdateCommand({
          TableName: this.tableName,
          Key: runKey(coords),
          // First start overwrites the launcher's createdAt placeholder in
          // originalStartedAt: the deadline anchor is the first EXECUTION
          // start, so time spent QUEUED never counts against the deadline.
          UpdateExpression: opts.markStarted
            ? 'SET taskToken = :token, #status = :running, startedAt = :now, originalStartedAt = :now'
            : 'SET taskToken = :token, #status = :running',
          ConditionExpression: '#status IN (:pending, :queued, :running)',
          ExpressionAttributeNames: { '#status': 'status' },
          ExpressionAttributeValues: {
            ':token': taskToken,
            ':running': 'RUNNING',
            ':pending': 'PENDING',
            ':queued': 'QUEUED',
            ...(opts.markStarted ? { ':now': nowIso } : {}),
          },
        }),
      );
      return 'ok';
    } catch (err) {
      if (isConditionalCheckFailure(err)) {
        return 'terminal';
      }
      throw err;
    }
  }

  async listJobs(coords: RunCoordinates): Promise<readonly JobItem[]> {
    return queryJobRows(this.client, this.tableName, coords);
  }

  async claimDispatch(
    coords: RunCoordinates,
    job: string,
    expectedAttempts: number,
    nowMs: number,
  ): Promise<boolean> {
    try {
      await this.client.send(
        new UpdateCommand({
          TableName: this.tableName,
          Key: jobKey(coords, job),
          UpdateExpression:
            'SET attempts = :next, dispatchedAt = :now, #status = :queued, repo = :repo, ' +
            'workflow = :workflow, runNumber = :runNumber, #job = :job, #ttl = :expiresAt ' +
            'REMOVE buildId, buildArn, logStreamName, startedAt, finishedAt, skipReason',
          ConditionExpression:
            expectedAttempts === 0
              ? 'attribute_not_exists(attempts) OR attempts = :expected'
              : 'attempts = :expected',
          ExpressionAttributeNames: { '#status': 'status', '#job': 'job', '#ttl': 'expiresAt' },
          ExpressionAttributeValues: {
            ':next': expectedAttempts + 1,
            ':expected': expectedAttempts,
            ':now': new Date(nowMs).toISOString(),
            ':queued': 'QUEUED',
            ':repo': coords.repo,
            ':workflow': coords.workflow,
            ':runNumber': coords.runNumber,
            ':job': job,
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

  async recordDispatch(
    coords: RunCoordinates,
    job: string,
    attempts: number,
    buildId: string,
    buildArn: string | undefined,
    _nowMs: number,
  ): Promise<void> {
    const mapping: BuildMappingItem = {
      ...buildMappingKey(buildId),
      repo: coords.repo,
      workflow: coords.workflow,
      runNumber: coords.runNumber,
      job,
      // No TTL yet: the build-events handler stamps it past terminality.
    };
    try {
      await this.client.send(
        new TransactWriteCommand({
          TransactItems: [
            {
              Update: {
                TableName: this.tableName,
                Key: jobKey(coords, job),
                UpdateExpression: 'SET buildId = :buildId, buildArn = :buildArn',
                // Fenced on our own claim: if a later iteration reclaimed a
                // stale attempt meanwhile, this build stays unmapped and its
                // events fall through harmlessly.
                ConditionExpression: 'attempts = :attempts',
                ExpressionAttributeValues: {
                  ':buildId': buildId,
                  ':buildArn': buildArn ?? buildId,
                  ':attempts': attempts,
                },
              },
            },
            { Put: { TableName: this.tableName, Item: mapping } },
          ],
        }),
      );
    } catch (err) {
      if ((err as { name?: string })?.name === 'TransactionCanceledException') {
        return;
      }
      throw err;
    }
  }

  async writeJobProjection(
    coords: RunCoordinates,
    job: string,
    patch: JobProjectionPatch,
    nowMs: number,
  ): Promise<void> {
    try {
      await this.client.send(
        new UpdateCommand(
          jobProjectionUpdate(this.tableName, coords, job, patch, nowMs, this.metadataRetentionDays),
        ),
      );
    } catch (err) {
      if (!isConditionalCheckFailure(err)) {
        throw err;
      }
    }
  }

  async finishRun(coords: RunCoordinates, status: RunItem['status'], nowMs: number): Promise<void> {
    try {
      await this.client.send(
        new UpdateCommand({
          TableName: this.tableName,
          Key: runKey(coords),
          UpdateExpression: 'SET #status = :status, finishedAt = :now REMOVE taskToken',
          ConditionExpression: '#status IN (:pending, :queued, :running)',
          ExpressionAttributeNames: { '#status': 'status' },
          ExpressionAttributeValues: {
            ':status': status,
            ':now': new Date(nowMs).toISOString(),
            ':pending': 'PENDING',
            ':queued': 'QUEUED',
            ':running': 'RUNNING',
          },
        }),
      );
    } catch (err) {
      if (!isConditionalCheckFailure(err)) {
        throw err;
      }
    }
  }
}
