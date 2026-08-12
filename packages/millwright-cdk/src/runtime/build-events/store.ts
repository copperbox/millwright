import {
  BUILD_MAPPING_TTL_SECONDS,
  BuildMappingItem,
  RunCoordinates,
  RunItem,
  buildMappingKey,
  expiresAtAfterSeconds,
  runKey,
} from '@copperbox/millwright-state';
import type { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import { GetCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb';
import { JobProjectionPatch, isConditionalCheckFailure, jobProjectionUpdate } from '../shared/jobs';
import { BuildEventsStore } from './build-events';

/**
 * The build-events handler's state-table access (spec §10.3): job-row
 * projection updates via the `BUILD#` lookup, plus the run read that yields
 * the wake token. Display-plane throughout — nothing here decides anything.
 */
export class DynamoBuildEventsStore implements BuildEventsStore {
  constructor(
    private readonly client: DynamoDBDocumentClient,
    private readonly tableName: string,
    private readonly metadataRetentionDays: number,
  ) {}

  async getBuildMapping(buildId: string): Promise<BuildMappingItem | undefined> {
    const result = await this.client.send(
      new GetCommand({
        TableName: this.tableName,
        Key: buildMappingKey(buildId),
        ConsistentRead: true,
      }),
    );
    return result.Item as BuildMappingItem | undefined;
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
      // The row no longer shows this build (a bounded retry replaced it);
      // this event is history and must not clobber the newer attempt.
      if (!isConditionalCheckFailure(err)) {
        throw err;
      }
    }
  }

  async stampBuildMappingTtl(buildId: string, nowMs: number): Promise<void> {
    await this.client.send(
      new UpdateCommand({
        TableName: this.tableName,
        Key: buildMappingKey(buildId),
        UpdateExpression: 'SET #ttl = :expiresAt',
        ConditionExpression: 'attribute_exists(pk)',
        ExpressionAttributeNames: { '#ttl': 'expiresAt' },
        ExpressionAttributeValues: {
          ':expiresAt': expiresAtAfterSeconds(nowMs, BUILD_MAPPING_TTL_SECONDS),
        },
      }),
    );
  }

  async getRun(coords: RunCoordinates): Promise<RunItem | undefined> {
    const result = await this.client.send(
      new GetCommand({ TableName: this.tableName, Key: runKey(coords), ConsistentRead: true }),
    );
    return result.Item as RunItem | undefined;
  }
}
