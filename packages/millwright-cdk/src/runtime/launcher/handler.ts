import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { SFNClient } from '@aws-sdk/client-sfn';
import { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import { DEFAULT_METADATA_RETENTION_DAYS } from '@copperbox/millwright-state';
import { SfnExecutionStarter } from './executions';
import { BusEventEnvelope, LauncherDeps, processBusEvent } from './launcher';
import { DynamoLauncherStore } from './store';

/**
 * Lambda entry point. Bus events reach the launcher through an SQS queue
 * (rule → queue → this function): a thrown record goes back to the queue and
 * redelivers after the visibility timeout, which is both the crash-recovery
 * path and the bootstrap replay mechanism — no side channel, bounded by the
 * queue's 24 h retention (mirroring EventBridge's own retry ceiling).
 */

interface SqsRecord {
  readonly messageId: string;
  readonly body: string;
}

interface SqsEvent {
  readonly Records: readonly SqsRecord[];
}

interface SqsBatchResponse {
  readonly batchItemFailures: { readonly itemIdentifier: string }[];
}

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Missing required environment variable ${name}`);
  }
  return value;
}

function log(message: string, fields?: Record<string, unknown>): void {
  console.log(JSON.stringify({ message, ...fields }));
}

let deps: LauncherDeps | undefined;

function dependencies(): LauncherDeps {
  if (!deps) {
    const dynamo = DynamoDBDocumentClient.from(new DynamoDBClient({}), {
      marshallOptions: { removeUndefinedValues: true },
    });
    const metadataRetentionDays = process.env.METADATA_RETENTION_DAYS
      ? Number(process.env.METADATA_RETENTION_DAYS)
      : DEFAULT_METADATA_RETENTION_DAYS;
    deps = {
      store: new DynamoLauncherStore(
        dynamo,
        requireEnv('STATE_TABLE_NAME'),
        metadataRetentionDays,
      ),
      starter: new SfnExecutionStarter(new SFNClient({}), requireEnv('RUN_EXECUTOR_ARN'), log),
      metadataRetentionDays,
      log,
    };
  }
  return deps;
}

export const handler = async (event: SqsEvent): Promise<SqsBatchResponse> => {
  const batchItemFailures: { itemIdentifier: string }[] = [];
  for (const record of event.Records) {
    let envelope: BusEventEnvelope;
    try {
      envelope = JSON.parse(record.body) as BusEventEnvelope;
    } catch {
      // Only the bus writes here; an unparseable body can never become
      // parseable, so drop it loudly rather than poison the queue.
      log('dropping unparseable record', { messageId: record.messageId });
      continue;
    }
    try {
      const disposition = await processBusEvent(dependencies(), envelope, Date.now());
      log('event processed', {
        source: envelope.source,
        detailType: envelope['detail-type'],
        disposition,
      });
    } catch (err) {
      log('delivery will retry', {
        source: envelope.source,
        detailType: envelope['detail-type'],
        error: (err as Error).message,
      });
      batchItemFailures.push({ itemIdentifier: record.messageId });
    }
  }
  return { batchItemFailures };
};
