import {
  BuildMappingItem,
  JobItem,
  JobStatus,
  RunCoordinates,
  RunItem,
  buildMappingKey,
  expiresAtAfterDays,
  jobKey,
  runKey,
} from '@copperbox/millwright-state';
import { PutCommand, TransactWriteCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb';
import { DesiredCheckWrite, sendDesiredCheckUpsert } from '../shared/checks';
import { DynamoGroupSlotStore } from '../shared/groups';
import {
  JobProjectionPatch,
  RunRows,
  isConditionalCheckFailure,
  jobCheckedStatusUpdate,
  jobProjectionUpdate,
  queryRunRows,
} from '../shared/jobs';
import { finishRunConditionally } from '../shared/runs';
import { DeciderStore, IterationBegun } from './iteration';

/**
 * The decider's state-table access (spec §7.8 write partition: run + job
 * rows, `BUILD#` items, group-slot releases via the shared base). Dispatch
 * claims are conditional on the exact attempt count and terminal transitions
 * on a live status, so concurrent iterations — possible when a wake lands
 * while a decider is still running — can never double-dispatch an attempt or
 * resurrect a finished run.
 */
export class DynamoDeciderStore extends DynamoGroupSlotStore implements DeciderStore {
  async beginIteration(
    coords: RunCoordinates,
    taskToken: string,
    opts: { readonly markStarted: boolean },
    nowMs: number,
  ): Promise<IterationBegun | 'terminal'> {
    const nowIso = new Date(nowMs).toISOString();
    try {
      const result = await this.client.send(
        new UpdateCommand({
          TableName: this.tableName,
          Key: runKey(coords),
          // First start overwrites the launcher's createdAt placeholder in
          // originalStartedAt: the deadline anchor is the first EXECUTION
          // start, so time spent QUEUED never counts against the deadline.
          // The sequence counter is bumped in the same conditional write, so
          // it is unique per iteration and ordered the way iterations began.
          UpdateExpression:
            (opts.markStarted
              ? 'SET taskToken = :token, #status = :running, startedAt = :now, originalStartedAt = :now'
              : 'SET taskToken = :token, #status = :running') + ' ADD deciderSequence :one',
          ConditionExpression: '#status IN (:pending, :queued, :running)',
          ExpressionAttributeNames: { '#status': 'status' },
          ExpressionAttributeValues: {
            ':token': taskToken,
            ':running': 'RUNNING',
            ':pending': 'PENDING',
            ':queued': 'QUEUED',
            ':one': 1,
            ...(opts.markStarted ? { ':now': nowIso } : {}),
          },
          ReturnValues: 'ALL_NEW',
        }),
      );
      const sequence = (result.Attributes as RunItem | undefined)?.deciderSequence;
      if (typeof sequence !== 'number') {
        throw new Error(`beginIteration returned no deciderSequence for ${runKey(coords).pk}`);
      }
      return { sequence };
    } catch (err) {
      if (isConditionalCheckFailure(err)) {
        return 'terminal';
      }
      throw err;
    }
  }

  async listRunRows(coords: RunCoordinates): Promise<RunRows> {
    return queryRunRows(this.client, this.tableName, coords);
  }

  async putDesiredCheck(write: DesiredCheckWrite, nowMs: number): Promise<boolean> {
    return sendDesiredCheckUpsert(
      this.client,
      this.tableName,
      write,
      nowMs,
      this.metadataRetentionDays,
    );
  }

  async markJobChecked(coords: RunCoordinates, job: string, status: JobStatus): Promise<void> {
    try {
      await this.client.send(
        new UpdateCommand(jobCheckedStatusUpdate(this.tableName, coords, job, status)),
      );
    } catch (err) {
      // No row yet (a row-less job opened `queued`): nothing to mark.
      if (!isConditionalCheckFailure(err)) {
        throw err;
      }
    }
  }

  async seedReusedJob(
    coords: RunCoordinates,
    job: string,
    reusedFrom: string,
    nowMs: number,
  ): Promise<void> {
    const item: JobItem = {
      ...jobKey(coords, job),
      repo: coords.repo,
      workflow: coords.workflow,
      runNumber: coords.runNumber,
      job,
      status: 'SUCCEEDED',
      reusedFrom,
      finishedAt: new Date(nowMs).toISOString(),
      expiresAt: expiresAtAfterDays(nowMs, this.metadataRetentionDays),
    };
    try {
      await this.client.send(
        new PutCommand({
          TableName: this.tableName,
          Item: item,
          // Seed exactly once: an existing row — another iteration's seed or
          // real dispatch state — is never overwritten.
          ConditionExpression: 'attribute_not_exists(pk)',
        }),
      );
    } catch (err) {
      if (!isConditionalCheckFailure(err)) {
        throw err;
      }
    }
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

  async finishRun(
    coords: RunCoordinates,
    status: RunItem['status'],
    sequence: number,
    nowMs: number,
  ): Promise<boolean> {
    return finishRunConditionally(this.client, this.tableName, coords, status, nowMs, { sequence });
  }
}
