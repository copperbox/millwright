import { randomUUID } from 'node:crypto';
import { PutEventsCommand } from '@aws-sdk/client-eventbridge';
import { SendTaskSuccessCommand } from '@aws-sdk/client-sfn';
import { GetCommand, QueryCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb';
import {
  CLI_EVENT_SOURCE,
  JobItem,
  RERUNNABLE_JOB_STATUSES,
  RunCoordinates,
  RunItem,
  RunStatus,
  TERMINAL_RUN_STATUSES,
  formatRunId,
  parseRunId,
  runKey,
  runPartitionKey,
} from '@copperbox/millwright-state';
import { Deployment } from './discovery';

/**
 * `millwright runs cancel` and `millwright runs rerun` (spec §7.6–§7.7).
 *
 * Cancellation is decider input, not an outside kill: cancel writes
 * `cancelRequested` on the run record and completes the current task token
 * (read from the Run item, stale-safe) so the decider wakes, StopBuilds
 * in-flight builds and lands every job terminal. `StopExecution` stays
 * break-glass only — this module never calls it.
 *
 * Rerun only validates locally and emits the `rerun` bus event; the
 * LAUNCHER owns run creation and the artifact prefix-copy. The CLI's write
 * surface stays exactly §10.3's: `cancelRequested` + `states:SendTaskSuccess`
 * + `events:PutEvents` under `source: millwright.cli`.
 */

export class RunsCommandError extends Error {}

/** The client slices these commands need; lets tests inject fakes. */
export interface AwsClientLike {
  send(command: unknown): Promise<any>;
}

/** Task-token errors that mean "stale token" — swallowed, wakes converge. */
function isStaleTokenError(err: unknown): boolean {
  const name = (err as { name?: string })?.name;
  return name === 'TaskTimedOut' || name === 'InvalidToken' || name === 'TaskDoesNotExist';
}

/**
 * Resolve a run reference: `owner/name#workflow#number` stands alone;
 * `workflow#number` needs `--repo`.
 */
export function resolveRunRef(ref: string, repo?: string): RunCoordinates {
  const parts = ref.split('#');
  if (parts.length === 2 && !repo) {
    throw new RunsCommandError(
      `"${ref}" is repo-scoped — pass --repo <owner/name>, or use the full ` +
        'owner/name#workflow#number form',
    );
  }
  const runId = parts.length === 2 ? `${repo}#${ref}` : ref;
  try {
    return parseRunId(runId);
  } catch {
    throw new RunsCommandError(
      `"${ref}" is not a run reference; expected workflow#number (with --repo) ` +
        'or owner/name#workflow#number',
    );
  }
}

/** A physical resource name from the deployment manifest. */
export function manifestResource(deployment: Deployment, key: string): string {
  const resources = deployment.manifest.resources;
  const value =
    typeof resources === 'object' && resources !== null
      ? (resources as Record<string, unknown>)[key]
      : undefined;
  if (typeof value !== 'string' || !value) {
    throw new RunsCommandError(
      `Deployment "${deployment.name}" has no "${key}" in its manifest resources — ` +
        'redeploy with a current @copperbox/millwright-cdk',
    );
  }
  return value;
}

export interface CancelResult {
  readonly runId: string;
  readonly status: RunStatus;
  /** False when the run was already terminal — nothing left to cancel. */
  readonly requested: boolean;
  /** True when a live task token was completed to wake the decider now. */
  readonly woke: boolean;
}

export async function cancelRun(
  deps: { dynamo: AwsClientLike; sfn: AwsClientLike; tableName: string },
  coords: RunCoordinates,
): Promise<CancelResult> {
  const runId = formatRunId(coords);
  let updated: { Attributes?: RunItem };
  try {
    updated = await deps.dynamo.send(
      new UpdateCommand({
        TableName: deps.tableName,
        Key: runKey(coords),
        UpdateExpression: 'SET cancelRequested = :true',
        ConditionExpression: 'attribute_exists(pk)',
        ExpressionAttributeValues: { ':true': true },
        ReturnValues: 'ALL_NEW',
      }),
    );
  } catch (err) {
    if ((err as { name?: string })?.name === 'ConditionalCheckFailedException') {
      throw new RunsCommandError(`No run ${runId} in this deployment`);
    }
    throw err;
  }
  const run = updated.Attributes;
  const status = run?.status ?? 'PENDING';
  if (TERMINAL_RUN_STATUSES.includes(status)) {
    return { runId, status, requested: false, woke: false };
  }

  // Wake the decider now instead of waiting for the 60 s timeout. The token
  // is read from the Run item and may be stale — the wake is best-effort
  // and idempotent, so stale-token errors are swallowed (spec §7.3).
  let woke = false;
  if (run?.taskToken) {
    try {
      await deps.sfn.send(
        new SendTaskSuccessCommand({
          taskToken: run.taskToken,
          output: JSON.stringify({ outcome: 'wake' }),
        }),
      );
      woke = true;
    } catch (err) {
      if (!isStaleTokenError(err)) {
        throw err;
      }
    }
  }
  return { runId, status, requested: true, woke };
}

export interface RerunResult {
  readonly sourceRunId: string;
  readonly failedOnly: boolean;
  /** Dedupe qualifier carried on the emitted event. */
  readonly nonce: string;
}

export async function rerunRun(
  deps: {
    dynamo: AwsClientLike;
    events: AwsClientLike;
    tableName: string;
    busName: string;
    /** Nonce source, injectable for tests. @default randomUUID */
    nonce?: () => string;
  },
  coords: RunCoordinates,
  options: { readonly failed: boolean },
): Promise<RerunResult> {
  const sourceRunId = formatRunId(coords);
  const result = await deps.dynamo.send(
    new GetCommand({ TableName: deps.tableName, Key: runKey(coords), ConsistentRead: true }),
  );
  const run = result.Item as RunItem | undefined;
  if (!run) {
    throw new RunsCommandError(`No run ${sourceRunId} in this deployment`);
  }
  if (!TERMINAL_RUN_STATUSES.includes(run.status)) {
    throw new RunsCommandError(
      `Run ${sourceRunId} is ${run.status} — cancel it or wait for it to finish before rerunning`,
    );
  }

  if (options.failed) {
    const rows = await listJobRows(deps.dynamo, deps.tableName, coords);
    const anyFailed = rows.some((row) => RERUNNABLE_JOB_STATUSES.includes(row.status));
    if (!anyFailed) {
      throw new RunsCommandError(
        `Nothing failed in ${sourceRunId} — drop --failed to rerun everything`,
      );
    }
  }

  const nonce = (deps.nonce ?? (() => randomUUID().replaceAll('-', '')))();
  const put = await deps.events.send(
    new PutEventsCommand({
      Entries: [
        {
          EventBusName: deps.busName,
          Source: CLI_EVENT_SOURCE,
          DetailType: 'rerun',
          Detail: JSON.stringify({
            repo: run.repo,
            ref: run.ref,
            sha: run.sha,
            kind: 'rerun',
            workflow: run.workflow,
            sourceRunNumber: run.runNumber,
            failedOnly: options.failed,
            nonce,
          }),
        },
      ],
    }),
  );
  if ((put.FailedEntryCount ?? 0) > 0) {
    const entry = put.Entries?.[0];
    throw new RunsCommandError(
      `The event bus rejected the rerun event: ${entry?.ErrorCode ?? 'unknown'} ` +
        `${entry?.ErrorMessage ?? ''}`.trim(),
    );
  }
  return { sourceRunId, failedOnly: options.failed, nonce };
}

async function listJobRows(
  dynamo: AwsClientLike,
  tableName: string,
  coords: RunCoordinates,
): Promise<readonly JobItem[]> {
  const items: JobItem[] = [];
  let lastKey: Record<string, unknown> | undefined;
  do {
    const result = await dynamo.send(
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
