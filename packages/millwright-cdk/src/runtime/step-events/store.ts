import type { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import { UpdateCommand } from '@aws-sdk/lib-dynamodb';
import { ValidStepEvent, expiresAtAfterDays, stepKey } from '@copperbox/millwright-state';
import { isConditionalCheckFailure } from '../shared/jobs';
import { StepEventsStore } from './step-events';

/**
 * The step-events writer's state-table access (spec §10.3: step-row writes
 * only — its role carries UpdateItem and nothing else). One upsert per
 * event; the `(run, job, step-index)` key makes duplicates converge.
 *
 * Ordering fence: a RUNNING write only lands on a missing row or one still
 * RUNNING, so a late or redelivered start can never regress the terminal
 * status a finished step already reported. Terminal writes are last-writer-
 * wins — the shim emits one terminal event per step index, so the only
 * repeats are duplicate deliveries writing identical values.
 */
export class DynamoStepEventsStore implements StepEventsStore {
  constructor(
    private readonly client: DynamoDBDocumentClient,
    private readonly tableName: string,
    private readonly metadataRetentionDays: number,
  ) {}

  async writeStepRow(event: ValidStepEvent, nowMs: number): Promise<'written' | 'superseded'> {
    const sets = [
      '#status = :status',
      'repo = :repo',
      'workflow = :workflow',
      'runNumber = :runNumber',
      '#job = :job',
      'stepIndex = :stepIndex',
      '#ttl = :expiresAt',
    ];
    const values: Record<string, unknown> = {
      ':status': event.status,
      ':repo': event.coords.repo,
      ':workflow': event.coords.workflow,
      ':runNumber': event.coords.runNumber,
      ':job': event.job,
      ':stepIndex': event.stepIndex,
      ':expiresAt': expiresAtAfterDays(nowMs, this.metadataRetentionDays),
    };
    for (const field of ['name', 'reason', 'startedAt', 'finishedAt'] as const) {
      if (event[field] !== undefined) {
        sets.push(`#${field} = :${field}`);
        values[`:${field}`] = event[field];
      }
    }
    try {
      await this.client.send(
        new UpdateCommand({
          TableName: this.tableName,
          Key: stepKey(event.coords, event.job, event.stepIndex),
          UpdateExpression: `SET ${sets.join(', ')}`,
          ...(event.status === 'RUNNING'
            ? { ConditionExpression: 'attribute_not_exists(pk) OR #status = :status' }
            : {}),
          ExpressionAttributeNames: {
            '#status': 'status',
            '#job': 'job',
            '#ttl': 'expiresAt',
            ...Object.fromEntries(
              ['name', 'reason', 'startedAt', 'finishedAt']
                .filter((field) => event[field as keyof ValidStepEvent] !== undefined)
                .map((field) => [`#${field}`, field]),
            ),
          },
          ExpressionAttributeValues: values,
        }),
      );
    } catch (err) {
      if (isConditionalCheckFailure(err)) {
        return 'superseded';
      }
      throw err;
    }
    return 'written';
  }
}
