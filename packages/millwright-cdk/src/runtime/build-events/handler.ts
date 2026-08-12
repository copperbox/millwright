import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { SFNClient, SendTaskSuccessCommand } from '@aws-sdk/client-sfn';
import { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import { DEFAULT_METADATA_RETENTION_DAYS } from '@copperbox/millwright-state';
import { isStaleTokenError } from '../shared/jobs';
import { log, requireEnv } from '../shared/lambda';
import {
  BuildEventsDeps,
  CodeBuildStateChangeEvent,
  WakeSender,
  processBuildStateChange,
} from './build-events';
import { DynamoBuildEventsStore } from './store';

/**
 * Build-events Lambda entry point (C7), targeted by the EventBridge rule on
 * the default bus's CodeBuild build-state events. A thrown error lets
 * EventBridge's async retry redeliver; every write here is idempotent and
 * the wake is pure signal, so redelivery is safe.
 */

class SfnWakeSender implements WakeSender {
  constructor(private readonly client: SFNClient) {}

  async wake(taskToken: string): Promise<'sent' | 'stale'> {
    try {
      await this.client.send(
        new SendTaskSuccessCommand({ taskToken, output: JSON.stringify({ outcome: 'wake' }) }),
      );
      return 'sent';
    } catch (err) {
      // TaskTimedOut / InvalidToken: the token was consumed between our read
      // and this send. The decider reconciles on its next entry regardless.
      if (isStaleTokenError(err)) {
        return 'stale';
      }
      throw err;
    }
  }
}

let deps: BuildEventsDeps | undefined;

function dependencies(): BuildEventsDeps {
  if (!deps) {
    const dynamo = DynamoDBDocumentClient.from(new DynamoDBClient({}), {
      marshallOptions: { removeUndefinedValues: true },
    });
    const metadataRetentionDays = process.env.METADATA_RETENTION_DAYS
      ? Number(process.env.METADATA_RETENTION_DAYS)
      : DEFAULT_METADATA_RETENTION_DAYS;
    deps = {
      store: new DynamoBuildEventsStore(
        dynamo,
        requireEnv('STATE_TABLE_NAME'),
        metadataRetentionDays,
      ),
      sender: new SfnWakeSender(new SFNClient({})),
      log,
    };
  }
  return deps;
}

export const handler = async (event: CodeBuildStateChangeEvent): Promise<void> => {
  const disposition = await processBuildStateChange(dependencies(), event, Date.now());
  log('build state change handled', {
    buildArn: event.detail?.['build-id'],
    buildStatus: event.detail?.['build-status'],
    disposition,
  });
};
