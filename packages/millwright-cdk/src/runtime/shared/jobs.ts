import {
  JobItem,
  JobStatus,
  RunCoordinates,
  SkipReason,
  expiresAtAfterDays,
  jobKey,
  runPartitionKey,
} from '@copperbox/millwright-state';
import type { DynamoDBDocumentClient, UpdateCommandInput } from '@aws-sdk/lib-dynamodb';
import { QueryCommand } from '@aws-sdk/lib-dynamodb';

/**
 * Job-row projection writes shared by the decider and the build-events
 * handler. Job rows are display-plane (spec §7.3): `BatchGetBuilds` stays
 * authoritative for terminal states, so these writes are convergence, not
 * decisions — last writer wins, except that `ifBuildId` fences out late
 * writes for a superseded attempt's build.
 */
export interface JobProjectionPatch {
  readonly status: JobStatus;
  readonly skipReason?: SkipReason;
  readonly logStreamName?: string;
  readonly startedAt?: string;
  readonly finishedAt?: string;
  /** Apply only while the row still shows this build id. */
  readonly ifBuildId?: string;
}

export function jobProjectionUpdate(
  tableName: string,
  coords: RunCoordinates,
  job: string,
  patch: JobProjectionPatch,
  nowMs: number,
  retentionDays: number,
): UpdateCommandInput {
  const sets = [
    '#status = :status',
    'repo = :repo',
    'workflow = :workflow',
    'runNumber = :runNumber',
    '#job = :job',
    '#ttl = :expiresAt',
  ];
  const names: Record<string, string> = {
    '#status': 'status',
    '#job': 'job',
    '#ttl': 'expiresAt',
  };
  const values: Record<string, unknown> = {
    ':status': patch.status,
    ':repo': coords.repo,
    ':workflow': coords.workflow,
    ':runNumber': coords.runNumber,
    ':job': job,
    ':expiresAt': expiresAtAfterDays(nowMs, retentionDays),
  };
  for (const field of ['skipReason', 'logStreamName', 'startedAt', 'finishedAt'] as const) {
    if (patch[field] !== undefined) {
      sets.push(`${field} = :${field}`);
      values[`:${field}`] = patch[field];
    }
  }
  if (patch.ifBuildId !== undefined) {
    values[':ifBuildId'] = patch.ifBuildId;
  }
  return {
    TableName: tableName,
    Key: jobKey(coords, job),
    UpdateExpression: `SET ${sets.join(', ')}`,
    ...(patch.ifBuildId !== undefined ? { ConditionExpression: 'buildId = :ifBuildId' } : {}),
    ExpressionAttributeNames: names,
    ExpressionAttributeValues: values,
  };
}

/** A run's job rows (its `JOB#` sort keys, step rows filtered out). */
export async function queryJobRows(
  client: DynamoDBDocumentClient,
  tableName: string,
  coords: RunCoordinates,
): Promise<readonly JobItem[]> {
  const items: JobItem[] = [];
  let lastKey: Record<string, unknown> | undefined;
  do {
    const result = await client.send(
      new QueryCommand({
        TableName: tableName,
        KeyConditionExpression: 'pk = :pk AND begins_with(sk, :job)',
        ExpressionAttributeValues: { ':pk': runPartitionKey(coords), ':job': 'JOB#' },
        ConsistentRead: true,
        ExclusiveStartKey: lastKey,
      }),
    );
    for (const item of result.Items ?? []) {
      // The JOB# prefix also matches step rows (JOB#<name>#STEP#<i>).
      if (!(item.sk as string).includes('#STEP#')) {
        items.push(item as JobItem);
      }
    }
    lastKey = result.LastEvaluatedKey;
  } while (lastKey);
  return items;
}

export function isConditionalCheckFailure(err: unknown): boolean {
  return (err as { name?: string })?.name === 'ConditionalCheckFailedException';
}

/** Task-token errors that mean "stale token" — always swallowed by senders. */
export function isStaleTokenError(err: unknown): boolean {
  const name = (err as { name?: string })?.name;
  return name === 'TaskTimedOut' || name === 'InvalidToken' || name === 'TaskDoesNotExist';
}
