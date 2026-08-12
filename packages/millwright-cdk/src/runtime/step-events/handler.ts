import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import { DEFAULT_METADATA_RETENTION_DAYS } from '@copperbox/millwright-state';
import { log, requireEnv } from '../shared/lambda';
import { StepBusEvent, StepEventsDeps, processStepEvent } from './step-events';
import { DynamoStepEventsStore } from './store';

/**
 * Step-events writer Lambda entry point (C19), targeted by the bus rule on
 * `source: millwright.step`. A thrown error lets EventBridge's async retry
 * redeliver; the row upsert is idempotent on `(run, job, step-index)`, so
 * redelivery is safe. Malformed events are dropped inside the core — retries
 * cannot repair shape.
 */

let deps: StepEventsDeps | undefined;

function dependencies(): StepEventsDeps {
  if (!deps) {
    const dynamo = DynamoDBDocumentClient.from(new DynamoDBClient({}), {
      marshallOptions: { removeUndefinedValues: true },
    });
    const metadataRetentionDays = process.env.METADATA_RETENTION_DAYS
      ? Number(process.env.METADATA_RETENTION_DAYS)
      : DEFAULT_METADATA_RETENTION_DAYS;
    deps = {
      store: new DynamoStepEventsStore(
        dynamo,
        requireEnv('STATE_TABLE_NAME'),
        metadataRetentionDays,
      ),
      log,
    };
  }
  return deps;
}

export const handler = async (event: StepBusEvent): Promise<void> => {
  const disposition = await processStepEvent(dependencies(), event, Date.now());
  log('step event handled', { detailType: event['detail-type'], disposition });
};
