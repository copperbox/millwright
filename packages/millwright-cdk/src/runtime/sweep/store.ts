import {
  CONCURRENCY_GROUP_PARTITION_PREFIX,
  ConcurrencyGroupItem,
  RunCoordinates,
  RunItem,
} from '@copperbox/millwright-state';
import { ScanCommand } from '@aws-sdk/lib-dynamodb';
import { DynamoGroupSlotStore } from '../shared/groups';
import { finishRunConditionally } from '../shared/runs';
import { SweepStore } from './sweep';

/**
 * The sweep's state-table access: the shared conditional slot writes plus the
 * group scan. `GROUP#` rows live in the single table without a GSI, so this
 * is a filtered Scan — it touches every item, which is acceptable at v1's
 * table sizes (90-day TTL, on-demand billing, one scan a minute) and is the
 * cost of not maintaining an index for a handful of rows. The terminal run
 * write is the decider's own conditional transition, shared.
 */
export class DynamoSweepStore extends DynamoGroupSlotStore implements SweepStore {
  async finishRun(
    coords: RunCoordinates,
    status: RunItem['status'],
    nowMs: number,
  ): Promise<boolean> {
    return finishRunConditionally(this.client, this.tableName, coords, status, nowMs);
  }

  async listGroups(): Promise<readonly ConcurrencyGroupItem[]> {
    const items: ConcurrencyGroupItem[] = [];
    let startKey: Record<string, unknown> | undefined;
    do {
      const result = await this.client.send(
        new ScanCommand({
          TableName: this.tableName,
          FilterExpression: 'begins_with(pk, :group)',
          ExpressionAttributeValues: { ':group': CONCURRENCY_GROUP_PARTITION_PREFIX },
          ExclusiveStartKey: startKey,
        }),
      );
      items.push(...((result.Items ?? []) as ConcurrencyGroupItem[]));
      startKey = result.LastEvaluatedKey;
    } while (startKey);
    return items;
  }
}
