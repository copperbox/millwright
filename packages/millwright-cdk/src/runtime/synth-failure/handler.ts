import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { SFNClient } from '@aws-sdk/client-sfn';
import { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import { DEFAULT_METADATA_RETENTION_DAYS } from '@copperbox/millwright-state';
import { SfnExecutionStarter } from '../shared/executions';
import { log, requireEnv } from '../shared/lambda';
import { DynamoSynthFailureStore } from './store';
import {
  SynthFailureDeps,
  SynthFailureEvent,
  SynthFailureResult,
  recordSynthFailure,
} from './synth-failure';

/**
 * Synth-failure Lambda entry point. Invoked by the run executor between the
 * synth phase's Catch and its `SynthFailed` Fail state; a throw here is
 * retried by the machine and then caught into `SynthFailed` regardless, so
 * the original synth error is never hidden by a cleanup failure.
 */

let deps: SynthFailureDeps | undefined;

function dependencies(): SynthFailureDeps {
  if (!deps) {
    const dynamo = DynamoDBDocumentClient.from(new DynamoDBClient({}), {
      marshallOptions: { removeUndefinedValues: true },
    });
    const metadataRetentionDays = process.env.METADATA_RETENTION_DAYS
      ? Number(process.env.METADATA_RETENTION_DAYS)
      : DEFAULT_METADATA_RETENTION_DAYS;
    deps = {
      store: new DynamoSynthFailureStore(
        dynamo,
        requireEnv('STATE_TABLE_NAME'),
        metadataRetentionDays,
      ),
      // Group hand-off: starts the pending run on this same state machine.
      starter: new SfnExecutionStarter(new SFNClient({}), requireEnv('RUN_EXECUTOR_ARN'), log),
      log,
    };
  }
  return deps;
}

export const handler = async (event: SynthFailureEvent): Promise<SynthFailureResult> => {
  const result = await recordSynthFailure(dependencies(), event, Date.now());
  log('synth failure recorded', { ...result });
  return result;
};
