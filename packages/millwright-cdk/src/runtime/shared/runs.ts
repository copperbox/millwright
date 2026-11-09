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
 */
export function finishRunUpdate(
  tableName: string,
  coords: RunCoordinates,
  status: RunItem['status'],
  nowMs: number,
): UpdateCommandInput {
  return {
    TableName: tableName,
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
  };
}

/** Issue the terminal transition; false when the run was already terminal. */
export async function finishRunConditionally(
  client: DynamoDBDocumentClient,
  tableName: string,
  coords: RunCoordinates,
  status: RunItem['status'],
  nowMs: number,
): Promise<boolean> {
  try {
    await client.send(new UpdateCommand(finishRunUpdate(tableName, coords, status, nowMs)));
    return true;
  } catch (err) {
    if (isConditionalCheckFailure(err)) {
      return false;
    }
    throw err;
  }
}
