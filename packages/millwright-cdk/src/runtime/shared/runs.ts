import { RunCoordinates, RunItem, runKey } from '@copperbox/millwright-state';
import type { DynamoDBDocumentClient, UpdateCommandInput } from '@aws-sdk/lib-dynamodb';
import { UpdateCommand } from '@aws-sdk/lib-dynamodb';
import { isConditionalCheckFailure } from './jobs';

/**
 * The run row's terminal transition, shared by every writer that ends a run:
 * the decider (job outcomes, cancellation, deadline), the synth-failure step
 * (a synth that never reached the loop) and the sweep (a non-terminal
 * occupant whose execution closed). Conditioned on a live status so a
 * finished run is never resurrected or re-stamped, whoever gets there second.
 *
 * The decider additionally fences on `deciderSequence`: its conclusion only
 * holds while it is the run's current iteration. A stalled iteration that
 * resumes after a later one began must not end the run, because its check
 * writes lose to the later iteration's `ownerSequence` fence, so the later
 * iteration, not it, has to write the completion.
 */
export interface FinishRunOptions {
  /** Require `deciderSequence` to still equal this iteration's sequence. */
  readonly sequence?: number;
}

export function finishRunUpdate(
  tableName: string,
  coords: RunCoordinates,
  status: RunItem['status'],
  nowMs: number,
  opts: FinishRunOptions = {},
): UpdateCommandInput {
  const fenced = opts.sequence !== undefined;
  return {
    TableName: tableName,
    Key: runKey(coords),
    UpdateExpression: 'SET #status = :status, finishedAt = :now REMOVE taskToken',
    ConditionExpression:
      '#status IN (:pending, :queued, :running)' +
      (fenced ? ' AND deciderSequence = :sequence' : ''),
    ExpressionAttributeNames: { '#status': 'status' },
    ExpressionAttributeValues: {
      ':status': status,
      ':now': new Date(nowMs).toISOString(),
      ':pending': 'PENDING',
      ':queued': 'QUEUED',
      ':running': 'RUNNING',
      ...(fenced ? { ':sequence': opts.sequence } : {}),
    },
  };
}

/**
 * Issue the terminal transition; false when the run was already terminal or,
 * with a sequence fence, when a later iteration has begun since.
 */
export async function finishRunConditionally(
  client: DynamoDBDocumentClient,
  tableName: string,
  coords: RunCoordinates,
  status: RunItem['status'],
  nowMs: number,
  opts: FinishRunOptions = {},
): Promise<boolean> {
  try {
    await client.send(new UpdateCommand(finishRunUpdate(tableName, coords, status, nowMs, opts)));
    return true;
  } catch (err) {
    if (isConditionalCheckFailure(err)) {
      return false;
    }
    throw err;
  }
}
