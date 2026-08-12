import {
  GetObjectCommand,
  ListObjectsV2Command,
  PutObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3';
import { CACHE_URI_ENV, OUT_URI_ENV } from '@copperbox/millwright-state';
import { DataPlaneDeps, JOB_NAME_ENV, defaultMarkerDir } from './data-plane';
import { FileObjectStore, ObjectStore, S3ObjectStore, parseDataPlaneUri } from './object-store';

/**
 * Host wiring for the data-plane subcommands: the dispatcher sets
 * `MILLWRIGHT_OUT_URI` / `MILLWRIGHT_CACHE_URI` to `s3://` URIs in the cloud
 * and to plain directory paths under the local runner (spec §11.2's
 * host-neutrality rule) — the store behind each is the only difference the
 * commands ever see. Stores are built lazily per env var so a job with no
 * cache never needs a cache root, and the S3 client is only constructed when
 * an `s3://` URI actually appears.
 */

function storeForUri(uri: string, s3: () => S3Client): ObjectStore {
  const parsed = parseDataPlaneUri(uri);
  if (parsed.kind === 's3') {
    return new S3ObjectStore(
      s3(),
      { GetObjectCommand, PutObjectCommand, ListObjectsV2Command },
      parsed.bucket!,
      parsed.prefix,
    );
  }
  return new FileObjectStore(parsed.prefix);
}

export function dataPlaneDepsFromEnv(
  env: NodeJS.ProcessEnv,
  log: (message: string) => void,
): DataPlaneDeps {
  let client: S3Client | undefined;
  const s3 = (): S3Client => (client ??= new S3Client({}));
  const outUri = env[OUT_URI_ENV];
  const cacheUri = env[CACHE_URI_ENV];
  return {
    workdir: process.cwd(),
    ...(outUri ? { outStore: storeForUri(outUri, s3) } : {}),
    ...(cacheUri ? { cacheStore: storeForUri(cacheUri, s3) } : {}),
    ...(env[JOB_NAME_ENV] ? { jobName: env[JOB_NAME_ENV] } : {}),
    markerDir: defaultMarkerDir(),
    log,
  };
}
