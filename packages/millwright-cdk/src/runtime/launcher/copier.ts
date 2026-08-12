import type { S3Client } from '@aws-sdk/client-s3';
import { CopyObjectCommand, ListObjectsV2Command } from '@aws-sdk/client-s3';
import { ArtifactCopier } from './launcher';

/**
 * The rerun prefix-copy (spec §7.7): the launcher role carries the S3 copy
 * grants, so succeeded jobs' `out/<job>/` subtrees — and the stored
 * `in/` model + packaged source, since reruns never re-synth — are copied
 * into the new run's prefix before its execution starts. Copies are
 * overwrite-idempotent: a redelivered event just copies the same objects
 * again.
 */
export class S3PrefixCopier implements ArtifactCopier {
  constructor(
    private readonly client: S3Client,
    private readonly bucket: string,
  ) {}

  async copyPrefix(fromPrefix: string, toPrefix: string): Promise<number> {
    let continuationToken: string | undefined;
    let copied = 0;
    do {
      const page = await this.client.send(
        new ListObjectsV2Command({
          Bucket: this.bucket,
          Prefix: fromPrefix,
          ContinuationToken: continuationToken,
        }),
      );
      for (const object of page.Contents ?? []) {
        if (!object.Key || !object.Key.startsWith(fromPrefix)) {
          continue;
        }
        await this.client.send(
          new CopyObjectCommand({
            Bucket: this.bucket,
            Key: `${toPrefix}${object.Key.slice(fromPrefix.length)}`,
            // CopySource is URI-encoded per path segment: object names under
            // out/<job>/ are job-authored and may carry anything.
            CopySource: [this.bucket, ...object.Key.split('/')]
              .map(encodeURIComponent)
              .join('/'),
          }),
        );
        copied++;
      }
      continuationToken = page.NextContinuationToken;
    } while (continuationToken);
    return copied;
  }
}
