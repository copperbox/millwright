import { GetObjectCommand, S3Client } from '@aws-sdk/client-s3';
import {
  SFNClient,
  SendTaskFailureCommand,
  SendTaskSuccessCommand,
} from '@aws-sdk/client-sfn';
import { SynthBuildEvent, processSynthBuildEvent } from './synth-events';

/** Lambda host for the synth-events completer. */

const sfn = new SFNClient({});
const s3 = new S3Client({});

/** Token already consumed, or the execution finished/timed out: not an error. */
function isStaleTokenError(err: unknown): boolean {
  const name = (err as { name?: string })?.name;
  return name === 'TaskTimedOut' || name === 'InvalidToken' || name === 'TaskDoesNotExist';
}

const sender = {
  async sendSuccess(taskToken: string, output: string): Promise<'sent' | 'stale'> {
    try {
      await sfn.send(new SendTaskSuccessCommand({ taskToken, output }));
      return 'sent';
    } catch (err) {
      if (isStaleTokenError(err)) {
        return 'stale';
      }
      throw err;
    }
  },
  async sendFailure(taskToken: string, error: string, cause: string): Promise<'sent' | 'stale'> {
    try {
      await sfn.send(new SendTaskFailureCommand({ taskToken, error, cause }));
      return 'sent';
    } catch (err) {
      if (isStaleTokenError(err)) {
        return 'stale';
      }
      throw err;
    }
  },
};

async function readObject(bucket: string, key: string): Promise<string | undefined> {
  try {
    const result = await s3.send(new GetObjectCommand({ Bucket: bucket, Key: key }));
    return await result.Body?.transformToString();
  } catch (err) {
    if ((err as { name?: string })?.name === 'NoSuchKey') {
      return undefined;
    }
    throw err;
  }
}

export async function handler(event: SynthBuildEvent): Promise<void> {
  const disposition = await processSynthBuildEvent(
    {
      sender,
      readObject,
      log: (message, fields) => console.log(JSON.stringify({ message, ...fields })),
    },
    event,
  );
  console.log(
    JSON.stringify({
      message: 'synth build event processed',
      disposition,
      buildArn: event.detail?.['build-id'],
    }),
  );
}
