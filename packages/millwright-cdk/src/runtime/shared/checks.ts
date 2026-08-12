import {
  DesiredCheckState,
  checkStateKey,
  expiresAtAfterDays,
  serializeDesiredCheckState,
} from '@copperbox/millwright-state';
import type { UpdateCommandInput } from '@aws-sdk/lib-dynamodb';

/**
 * The decider's desired-state upsert onto a check item (spec §13.2). Shared
 * here rather than living with the reporter because the reporter never
 * writes the desired side — deciders (and the bootstrap synth path) do.
 */
export interface DesiredCheckWrite {
  readonly repo: string;
  readonly sha: string;
  readonly context: string;
  /** Run identity as the CLI displays it, e.g. `ci#142`. */
  readonly ownerRun: string;
  /** The comparand for the ownership condition — total within one context. */
  readonly ownerRunNumber: number;
  readonly desired: DesiredCheckState;
}

/**
 * Ownership rule: the newest run owns the context. The write is conditional
 * on this run's number ≥ the stored owner's; the caller treats a conditional
 * failure as a silent drop (the older run's jobs still render in
 * `runs show`). `checkRunId` and `reported` are deliberately untouched so
 * same-or-newer writes carry the existing check run forward and the reporter
 * updates it instead of minting a duplicate. A fresh desired state restarts
 * reconciliation: backoff and abandonment are cleared, and `desiredAt`
 * re-anchors the 7-day abandonment clock.
 */
export function desiredCheckUpsert(
  tableName: string,
  write: DesiredCheckWrite,
  nowMs: number,
  retentionDays: number,
): UpdateCommandInput {
  return {
    TableName: tableName,
    Key: checkStateKey(write.repo, write.sha, write.context),
    UpdateExpression:
      'SET repo = :repo, sha = :sha, #context = :context, desired = :desired, ' +
      'desiredAt = :desiredAt, ownerRun = :ownerRun, ownerRunNumber = :ownerRunNumber, ' +
      '#ttl = :expiresAt REMOVE abandoned, backoffAttempts, nextAttemptAt',
    ConditionExpression:
      'attribute_not_exists(ownerRunNumber) OR ownerRunNumber <= :ownerRunNumber',
    ExpressionAttributeNames: { '#context': 'context', '#ttl': 'expiresAt' },
    ExpressionAttributeValues: {
      ':repo': write.repo,
      ':sha': write.sha,
      ':context': write.context,
      ':desired': serializeDesiredCheckState(write.desired),
      ':desiredAt': new Date(nowMs).toISOString(),
      ':ownerRun': write.ownerRun,
      ':ownerRunNumber': write.ownerRunNumber,
      ':expiresAt': expiresAtAfterDays(nowMs, retentionDays),
    },
  };
}

export function isConditionalCheckFailure(err: unknown): boolean {
  return (
    typeof err === 'object' &&
    err !== null &&
    (err as { name?: string }).name === 'ConditionalCheckFailedException'
  );
}
