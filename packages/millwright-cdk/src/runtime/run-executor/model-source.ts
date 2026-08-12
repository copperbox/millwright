import type { S3Client } from '@aws-sdk/client-s3';
import { GetObjectCommand } from '@aws-sdk/client-s3';
import { RunCoordinates, RunModel, modelObjectKey, parseRunModel } from '@copperbox/millwright-state';
import { ModelSource } from './iteration';

/**
 * Reads the run's validated `model.json` from `runs/…/in/` and caches it
 * in-process (spec §7.3): a warm decider container serves every iteration of
 * its runs from memory. The model is immutable per run — written once by the
 * synth step — so the cache never needs invalidation, only bounding.
 */
export class S3ModelSource implements ModelSource {
  private readonly cache = new Map<string, RunModel>();

  constructor(
    private readonly client: S3Client,
    private readonly bucketName: string,
    private readonly maxEntries = 16,
  ) {}

  async load(coords: RunCoordinates): Promise<RunModel> {
    const key = modelObjectKey(coords);
    const cached = this.cache.get(key);
    if (cached) {
      return cached;
    }
    const result = await this.client.send(
      new GetObjectCommand({ Bucket: this.bucketName, Key: key }),
    );
    const body = await result.Body?.transformToString();
    if (!body) {
      throw new Error(`Empty model object at s3://${this.bucketName}/${key}`);
    }
    const model = parseRunModel(JSON.parse(body));
    this.cache.set(key, model);
    while (this.cache.size > this.maxEntries) {
      this.cache.delete(this.cache.keys().next().value!);
    }
    return model;
  }
}
