/**
 * Read-only access to the state and polling tables for the observability
 * commands (spec §9.1, §9.4, §15). The state table is the CLI's source of
 * truth — there is no web UI — so `runs`/`logs`/`doctor` all funnel through
 * these queries. Everything here is display-plane: nothing the CLI renders
 * feeds back into orchestration decisions.
 */

import { GetCommand, QueryCommand } from '@aws-sdk/lib-dynamodb';
import {
  CheckStateItem,
  ItemKey,
  JobItem,
  RegistryItem,
  RunCoordinates,
  RunItem,
  RunStatus,
  StepItem,
  REGISTRY_PARTITION_PREFIX,
  RUN_SORT_KEY_PREFIX,
  parseJobKey,
  parseRegistryKey,
  parseStepKey,
  registryKey,
  runKey,
} from '@copperbox/millwright-state';

/** The slice of DynamoDBDocumentClient the CLI uses; tests inject a fake. */
export interface DynamoDocClientLike {
  send(command: unknown): Promise<any>;
}

async function queryAll(
  ddb: DynamoDocClientLike,
  table: string,
  pk: string,
  skPrefix?: string,
  limit?: number,
): Promise<Record<string, unknown>[]> {
  const items: Record<string, unknown>[] = [];
  let exclusiveStartKey: Record<string, unknown> | undefined;
  do {
    const page = await ddb.send(
      new QueryCommand({
        TableName: table,
        KeyConditionExpression:
          skPrefix === undefined ? 'pk = :pk' : 'pk = :pk AND begins_with(sk, :sk)',
        ExpressionAttributeValues:
          skPrefix === undefined ? { ':pk': pk } : { ':pk': pk, ':sk': skPrefix },
        ...(limit !== undefined ? { Limit: limit - items.length } : {}),
        ExclusiveStartKey: exclusiveStartKey,
      }),
    );
    items.push(...((page.Items ?? []) as Record<string, unknown>[]));
    exclusiveStartKey = page.LastEvaluatedKey;
  } while (exclusiveStartKey && (limit === undefined || items.length < limit));
  return items;
}

async function getItem(
  ddb: DynamoDocClientLike,
  table: string,
  key: ItemKey,
): Promise<Record<string, unknown> | undefined> {
  const result = await ddb.send(new GetCommand({ TableName: table, Key: { ...key } }));
  return result.Item as Record<string, unknown> | undefined;
}

/**
 * Narrowing for `queryNewestRuns`. `status` is an exact match the table
 * evaluates in a FilterExpression; `matches` runs client-side for checks
 * DynamoDB cannot express (the `--ref` filter accepts short and full forms).
 */
export interface RunFilter {
  readonly status?: RunStatus;
  readonly matches?: (run: RunItem) => boolean;
}

/**
 * Newest runs of one workflow. `RUN#` sort keys carry the inverted run
 * number, so plain ascending key order is descending run-number order.
 *
 * Without a filter this reads exactly `limit` rows. With one it keeps paging
 * the partition until `limit` *matching* runs are in hand or the partition
 * is exhausted — a filter that only saw the newest `limit` rows would miss
 * every older match and report "no runs". The filtered query sends no
 * `Limit`: DynamoDB applies `Limit` before `FilterExpression`, so it would
 * only multiply round trips without bounding the result.
 */
export async function queryNewestRuns(
  ddb: DynamoDocClientLike,
  table: string,
  repo: string,
  workflow: string,
  limit: number,
  filter?: RunFilter,
): Promise<RunItem[]> {
  const pk = `WF#${repo}#${workflow}`;
  if (filter?.status === undefined && filter?.matches === undefined) {
    const items = await queryAll(ddb, table, pk, RUN_SORT_KEY_PREFIX, limit);
    return items as unknown as RunItem[];
  }

  const runs: RunItem[] = [];
  let exclusiveStartKey: Record<string, unknown> | undefined;
  do {
    const page = await ddb.send(
      new QueryCommand({
        TableName: table,
        KeyConditionExpression: 'pk = :pk AND begins_with(sk, :sk)',
        ExpressionAttributeValues: {
          ':pk': pk,
          ':sk': RUN_SORT_KEY_PREFIX,
          ...(filter.status === undefined ? {} : { ':status': filter.status }),
        },
        // `status` is a DynamoDB reserved word, hence the name placeholder.
        ...(filter.status === undefined
          ? {}
          : {
              FilterExpression: '#status = :status',
              ExpressionAttributeNames: { '#status': 'status' },
            }),
        ExclusiveStartKey: exclusiveStartKey,
      }),
    );
    for (const item of (page.Items ?? []) as unknown as RunItem[]) {
      if (filter.matches && !filter.matches(item)) {
        continue;
      }
      runs.push(item);
      if (runs.length >= limit) {
        return runs;
      }
    }
    exclusiveStartKey = page.LastEvaluatedKey;
  } while (exclusiveStartKey);
  return runs;
}

export async function getRun(
  ddb: DynamoDocClientLike,
  table: string,
  coords: RunCoordinates,
): Promise<RunItem | undefined> {
  return (await getItem(ddb, table, runKey(coords))) as RunItem | undefined;
}

export interface RunDetail {
  readonly jobs: JobItem[];
  readonly steps: StepItem[];
}

/** Everything in a run's partition: job rows plus their step rows. */
export async function listRunDetail(
  ddb: DynamoDocClientLike,
  table: string,
  coords: RunCoordinates,
): Promise<RunDetail> {
  const pk = `RUN#${coords.repo}#${coords.workflow}#${coords.runNumber}`;
  const jobs: JobItem[] = [];
  const steps: StepItem[] = [];
  for (const item of await queryAll(ddb, table, pk)) {
    const key = { pk: item.pk as string, sk: item.sk as string };
    try {
      parseStepKey(key);
      steps.push(item as unknown as StepItem);
      continue;
    } catch {
      // not a step row
    }
    try {
      parseJobKey(key);
      jobs.push(item as unknown as JobItem);
    } catch {
      // unknown row shape in the run partition — skip it
    }
  }
  return { jobs, steps };
}

/** All registry entries for one repo (one per synthed ref). */
export async function listRegistryEntries(
  ddb: DynamoDocClientLike,
  table: string,
  repo: string,
): Promise<RegistryItem[]> {
  const items = await queryAll(ddb, table, `${REGISTRY_PARTITION_PREFIX}${repo}`);
  return items.filter((item) => {
    try {
      parseRegistryKey({ pk: item.pk as string, sk: item.sk as string });
      return true;
    } catch {
      return false;
    }
  }) as unknown as RegistryItem[];
}

export async function getRegistryEntry(
  ddb: DynamoDocClientLike,
  table: string,
  repo: string,
  ref: string,
): Promise<RegistryItem | undefined> {
  return (await getItem(ddb, table, registryKey(repo, ref))) as RegistryItem | undefined;
}

/** Check-state rows for one commit — `runs show` surfaces abandoned checks. */
export async function listCheckStates(
  ddb: DynamoDocClientLike,
  table: string,
  repo: string,
  sha: string,
): Promise<CheckStateItem[]> {
  const items = await queryAll(ddb, table, `CHECK#${repo}#${sha}`);
  return items as unknown as CheckStateItem[];
}

/** One polling-table item by key (doctor's poller/registry checks). */
export async function getPollingItem(
  ddb: DynamoDocClientLike,
  table: string,
  key: ItemKey,
): Promise<Record<string, unknown> | undefined> {
  return getItem(ddb, table, key);
}
