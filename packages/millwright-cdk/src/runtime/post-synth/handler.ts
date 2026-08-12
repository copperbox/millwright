import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { GetObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { DynamoDBDocumentClient, PutCommand } from '@aws-sdk/lib-dynamodb';
import { PostSynthEvent, PostSynthResult, completePostSynth } from './post-synth';

/**
 * Lambda host for the post-synth step (`<deploymentName>-post-synth`,
 * pinned name). A throw here is caught by the machine's synth-phase Catch
 * and fails the run — after the failure was surfaced in the synth check.
 */

const s3 = new S3Client({});
const documentClient = DynamoDBDocumentClient.from(new DynamoDBClient({}), {
  marshallOptions: { removeUndefinedValues: true },
});

function required(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Missing required environment variable ${name}`);
  }
  return value;
}

export async function handler(event: PostSynthEvent): Promise<PostSynthResult> {
  const bucket = required('ARTIFACT_BUCKET_NAME');
  const tableName = required('STATE_TABLE_NAME');
  return completePostSynth(
    {
      config: {
        schemaCeiling: Number(required('SCHEMA_CEILING')),
        metadataRetentionDays: Number(required('METADATA_RETENTION_DAYS')),
      },
      readObject: async (key) => {
        try {
          const result = await s3.send(new GetObjectCommand({ Bucket: bucket, Key: key }));
          return await result.Body?.transformToString();
        } catch (err) {
          if ((err as { name?: string })?.name === 'NoSuchKey') {
            return undefined;
          }
          throw err;
        }
      },
      store: {
        putRegistry: async (item) => {
          await documentClient.send(new PutCommand({ TableName: tableName, Item: item }));
        },
        putCheckState: async (item) => {
          await documentClient.send(new PutCommand({ TableName: tableName, Item: item }));
        },
      },
      now: () => Date.now(),
      log: (message, fields) => console.log(JSON.stringify({ message, ...fields })),
    },
    event,
  );
}
