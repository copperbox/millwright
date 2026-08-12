import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { SFNClient } from '@aws-sdk/client-sfn';
import { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import { DEFAULT_METADATA_RETENTION_DAYS } from '@copperbox/millwright-state';
import { SfnExecutionStarter } from '../shared/executions';
import { log, requireEnv } from '../shared/lambda';
import { DynamoSweepStore } from './store';
import { SweepDeps, sweepGroups } from './sweep';

/**
 * Sweep Lambda entry point (C16), on the 1-minute scheduler. Overlapping
 * ticks are safe — every repair write is conditional — and a failed tick
 * needs no retry: the next one re-runs the same convergence.
 */

let deps: SweepDeps | undefined;

function dependencies(): SweepDeps {
  if (!deps) {
    const dynamo = DynamoDBDocumentClient.from(new DynamoDBClient({}), {
      marshallOptions: { removeUndefinedValues: true },
    });
    const metadataRetentionDays = process.env.METADATA_RETENTION_DAYS
      ? Number(process.env.METADATA_RETENTION_DAYS)
      : DEFAULT_METADATA_RETENTION_DAYS;
    deps = {
      store: new DynamoSweepStore(dynamo, requireEnv('STATE_TABLE_NAME'), metadataRetentionDays),
      starter: new SfnExecutionStarter(new SFNClient({}), requireEnv('RUN_EXECUTOR_ARN'), log),
      log,
    };
  }
  return deps;
}

export const handler = async (): Promise<void> => {
  const report = await sweepGroups(dependencies(), Date.now());
  log('group sweep complete', { ...report });
};
