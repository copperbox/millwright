import { CheckStateItem, checkStateKey } from '@copperbox/millwright-state';
import type { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import { GetCommand, ScanCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb';
import { isConditionalCheckFailure } from '../shared/checks';
import { CheckCoordinates, ReporterStore } from './reporter';

/**
 * The reporter's state-table access (spec §13.2). The reporter owns only the
 * reported side of check items: acknowledgements, backoff state and
 * abandonment. Desired-side writes belong to the decider's conditional
 * upsert (`runtime/shared/checks.ts`).
 */
export class DynamoReporterStore implements ReporterStore {
  constructor(
    private readonly client: DynamoDBDocumentClient,
    private readonly tableName: string,
  ) {}

  async getCheck(coords: CheckCoordinates): Promise<CheckStateItem | undefined> {
    const result = await this.client.send(
      new GetCommand({
        TableName: this.tableName,
        Key: checkStateKey(coords.repo, coords.sha, coords.context),
        ConsistentRead: true,
      }),
    );
    return result.Item as CheckStateItem | undefined;
  }

  async markReported(
    coords: CheckCoordinates,
    seenDesired: string,
    checkRunId?: number,
  ): Promise<'applied' | 'stale'> {
    const withRunId = checkRunId !== undefined;
    try {
      await this.client.send(
        new UpdateCommand({
          TableName: this.tableName,
          Key: checkStateKey(coords.repo, coords.sha, coords.context),
          UpdateExpression:
            'SET reported = :reported' +
            (withRunId ? ', checkRunId = :checkRunId' : '') +
            ' REMOVE backoffAttempts, nextAttemptAt',
          ConditionExpression: 'desired = :seenDesired',
          ExpressionAttributeValues: {
            ':reported': seenDesired,
            ':seenDesired': seenDesired,
            ...(withRunId ? { ':checkRunId': checkRunId } : {}),
          },
        }),
      );
      return 'applied';
    } catch (err) {
      if (isConditionalCheckFailure(err)) {
        return 'stale';
      }
      throw err;
    }
  }

  async recordCheckRunId(coords: CheckCoordinates, checkRunId: number): Promise<void> {
    await this.updateIfPresent(coords, 'SET checkRunId = :checkRunId', {
      ':checkRunId': checkRunId,
    });
  }

  async recordAttemptFailure(
    coords: CheckCoordinates,
    backoffAttempts: number,
    nextAttemptAt: string,
  ): Promise<void> {
    await this.updateIfPresent(
      coords,
      'SET backoffAttempts = :backoffAttempts, nextAttemptAt = :nextAttemptAt',
      { ':backoffAttempts': backoffAttempts, ':nextAttemptAt': nextAttemptAt },
    );
  }

  async markAbandoned(coords: CheckCoordinates): Promise<void> {
    await this.updateIfPresent(coords, 'SET abandoned = :abandoned', { ':abandoned': true });
  }

  /** Reporter-side bookkeeping never resurrects an item TTL deletion removed. */
  private async updateIfPresent(
    coords: CheckCoordinates,
    updateExpression: string,
    values: Record<string, unknown>,
  ): Promise<void> {
    try {
      await this.client.send(
        new UpdateCommand({
          TableName: this.tableName,
          Key: checkStateKey(coords.repo, coords.sha, coords.context),
          UpdateExpression: updateExpression,
          ConditionExpression: 'attribute_exists(pk)',
          ExpressionAttributeValues: values,
        }),
      );
    } catch (err) {
      if (!isConditionalCheckFailure(err)) {
        throw err;
      }
    }
  }

  /**
   * Sweep input: a filtered table scan. Check items are a thin slice of the
   * table and the filter drops everything converged, so at the ~1,500
   * call/day budget this stays far below any practical scan cost; a GSI is
   * the pre-approved escalation if a deployment ever proves otherwise.
   */
  async listUnconverged(): Promise<CheckStateItem[]> {
    const items: CheckStateItem[] = [];
    let exclusiveStartKey: Record<string, unknown> | undefined;
    do {
      const result: {
        Items?: Record<string, unknown>[];
        LastEvaluatedKey?: Record<string, unknown>;
      } = await this.client.send(
        new ScanCommand({
          TableName: this.tableName,
          FilterExpression:
            'begins_with(pk, :checkPrefix) AND attribute_exists(desired) AND ' +
            'attribute_not_exists(abandoned) AND ' +
            '(attribute_not_exists(reported) OR reported <> desired)',
          ExpressionAttributeValues: { ':checkPrefix': 'CHECK#' },
          ...(exclusiveStartKey ? { ExclusiveStartKey: exclusiveStartKey } : {}),
        }),
      );
      items.push(...((result.Items ?? []) as unknown as CheckStateItem[]));
      exclusiveStartKey = result.LastEvaluatedKey;
    } while (exclusiveStartKey);
    return items;
  }
}
