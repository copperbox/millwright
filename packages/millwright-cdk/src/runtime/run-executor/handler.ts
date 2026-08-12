import { CodeBuildClient } from '@aws-sdk/client-codebuild';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { S3Client } from '@aws-sdk/client-s3';
import { SFNClient, SendTaskFailureCommand, SendTaskSuccessCommand } from '@aws-sdk/client-sfn';
import { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import { DEFAULT_METADATA_RETENTION_DAYS } from '@copperbox/millwright-state';
import { isStaleTokenError } from '../shared/jobs';
import { log, requireEnv } from '../shared/lambda';
import { CodeBuildRunner } from './codebuild';
import { DeciderDeps, DeciderTaskInput, TokenSender, runDeciderIteration } from './iteration';
import { S3ModelSource } from './model-source';
import { DynamoDeciderStore } from './store';

/**
 * Decider Lambda entry point (C6). Invoked by the run executor's token-wait
 * state; the payload carries this iteration's task token. A thrown error is
 * retried by the state machine's Retry policy; a normal return leaves the
 * machine parked on the token until a wake or its 60 s timeout.
 */

export const DEFAULT_ITERATION_BUDGET = 500;

class SfnTokenSender implements TokenSender {
  constructor(private readonly client: SFNClient) {}

  async success(taskToken: string, output: unknown): Promise<void> {
    try {
      await this.client.send(
        new SendTaskSuccessCommand({ taskToken, output: JSON.stringify(output) }),
      );
    } catch (err) {
      // A consumed token means the timeout beat this send; the next
      // iteration re-derives the same conclusion from table state.
      if (!isStaleTokenError(err)) {
        throw err;
      }
      log('task token already consumed; swallowing', { error: (err as Error).name });
    }
  }

  async failure(taskToken: string, error: string, cause: string): Promise<void> {
    try {
      await this.client.send(new SendTaskFailureCommand({ taskToken, error, cause }));
    } catch (err) {
      if (!isStaleTokenError(err)) {
        throw err;
      }
      log('task token already consumed; swallowing', { error: (err as Error).name });
    }
  }
}

let deps: DeciderDeps | undefined;

function dependencies(): DeciderDeps {
  if (!deps) {
    const dynamo = DynamoDBDocumentClient.from(new DynamoDBClient({}), {
      marshallOptions: { removeUndefinedValues: true },
    });
    const metadataRetentionDays = process.env.METADATA_RETENTION_DAYS
      ? Number(process.env.METADATA_RETENTION_DAYS)
      : DEFAULT_METADATA_RETENTION_DAYS;
    deps = {
      store: new DynamoDeciderStore(dynamo, requireEnv('STATE_TABLE_NAME'), metadataRetentionDays),
      runner: new CodeBuildRunner(new CodeBuildClient({}), {
        projectName: requireEnv('BUILD_PROJECT_NAME'),
        bucketName: requireEnv('ARTIFACT_BUCKET_NAME'),
        deploymentName: requireEnv('DEPLOYMENT_NAME'),
        eventBusName: requireEnv('EVENT_BUS_NAME'),
      }),
      models: new S3ModelSource(new S3Client({}), requireEnv('ARTIFACT_BUCKET_NAME')),
      sender: new SfnTokenSender(new SFNClient({})),
      iterationBudget: process.env.ITERATION_BUDGET
        ? Number(process.env.ITERATION_BUDGET)
        : DEFAULT_ITERATION_BUDGET,
      log,
    };
  }
  return deps;
}

export const handler = async (event: DeciderTaskInput): Promise<Record<string, never>> => {
  const outcome = await runDeciderIteration(dependencies(), event, Date.now());
  log('decider iteration complete', {
    runId: event.runId,
    iteration: event.iteration,
    outcome,
  });
  // The state's result arrives via SendTaskSuccess, never this return value.
  return {};
};
