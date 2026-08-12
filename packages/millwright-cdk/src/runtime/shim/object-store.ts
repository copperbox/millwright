import * as fs from 'node:fs';
import * as path from 'node:path';

/**
 * The shim's two data-plane backends behind one interface (spec §11.2's
 * host-neutrality rule): in the cloud the `MILLWRIGHT_OUT_URI` /
 * `MILLWRIGHT_CACHE_URI` env vars carry `s3://bucket/prefix` URIs and the
 * job role's IAM grants are the enforcement (§10.2); locally they are plain
 * filesystem paths and the runner owns the directory. Keys are always
 * relative to the URI's root — `<job>/<artifact>/…` under `out/`,
 * `<cache-key>` under `cache/<repo>/`.
 */

export class ObjectStoreError extends Error {}

export interface ObjectStat {
  readonly key: string;
  /** Epoch ms; drives "newest wins" among restore-key prefix matches. */
  readonly lastModified: number;
}

export interface ObjectStore {
  get(key: string): Promise<Buffer | undefined>;
  put(key: string, body: Buffer): Promise<void>;
  list(prefix: string): Promise<readonly ObjectStat[]>;
}

/**
 * Reject keys that could escape the store root. `/`-separated relative
 * paths only — the caller builds them from validated segments, this is the
 * backstop.
 */
export function assertSafeKey(key: string): void {
  const segments = key.split('/');
  if (!key || key.startsWith('/') || segments.some((s) => s === '' || s === '.' || s === '..')) {
    throw new ObjectStoreError(`unsafe object key "${key}"`);
  }
}

/** Local-runner and test backend: keys are files under a root directory. */
export class FileObjectStore implements ObjectStore {
  constructor(private readonly root: string) {}

  async get(key: string): Promise<Buffer | undefined> {
    assertSafeKey(key);
    try {
      return fs.readFileSync(path.join(this.root, ...key.split('/')));
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
        return undefined;
      }
      throw err;
    }
  }

  async put(key: string, body: Buffer): Promise<void> {
    assertSafeKey(key);
    const target = path.join(this.root, ...key.split('/'));
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, body);
  }

  async list(prefix: string): Promise<readonly ObjectStat[]> {
    const out: ObjectStat[] = [];
    const walk = (relDir: string): void => {
      const absDir = path.join(this.root, ...relDir.split('/').filter(Boolean));
      let entries: fs.Dirent[];
      try {
        entries = fs.readdirSync(absDir, { withFileTypes: true });
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
          return;
        }
        throw err;
      }
      for (const entry of entries) {
        const rel = relDir ? `${relDir}/${entry.name}` : entry.name;
        if (entry.isDirectory()) {
          walk(rel);
        } else if (entry.isFile() && rel.startsWith(prefix)) {
          const stat = fs.statSync(path.join(absDir, entry.name));
          out.push({ key: rel, lastModified: stat.mtimeMs });
        }
      }
    };
    walk('');
    return out;
  }
}

/**
 * The cloud backend. The client is the narrow slice of
 * `@aws-sdk/client-s3` the shim uses, injected so the SDK is only
 * constructed (and only bundled reachable) on the cloud path.
 */
export interface S3ClientLike {
  send(command: unknown): Promise<unknown>;
}

interface S3Commands {
  GetObjectCommand: new (input: { Bucket: string; Key: string }) => unknown;
  PutObjectCommand: new (input: { Bucket: string; Key: string; Body: Buffer }) => unknown;
  ListObjectsV2Command: new (input: {
    Bucket: string;
    Prefix: string;
    ContinuationToken?: string;
  }) => unknown;
}

export class S3ObjectStore implements ObjectStore {
  constructor(
    private readonly client: S3ClientLike,
    private readonly commands: S3Commands,
    private readonly bucket: string,
    /** Trailing-slash-free root the relative keys live under. */
    private readonly rootPrefix: string,
  ) {}

  private absolute(key: string): string {
    return this.rootPrefix ? `${this.rootPrefix}/${key}` : key;
  }

  async get(key: string): Promise<Buffer | undefined> {
    assertSafeKey(key);
    try {
      const result = (await this.client.send(
        new this.commands.GetObjectCommand({ Bucket: this.bucket, Key: this.absolute(key) }),
      )) as { Body?: { transformToByteArray(): Promise<Uint8Array> } };
      if (!result.Body) {
        return undefined;
      }
      return Buffer.from(await result.Body.transformToByteArray());
    } catch (err) {
      const name = (err as { name?: string }).name;
      if (name === 'NoSuchKey' || name === 'NotFound') {
        return undefined;
      }
      throw err;
    }
  }

  async put(key: string, body: Buffer): Promise<void> {
    assertSafeKey(key);
    await this.client.send(
      new this.commands.PutObjectCommand({ Bucket: this.bucket, Key: this.absolute(key), Body: body }),
    );
  }

  async list(prefix: string): Promise<readonly ObjectStat[]> {
    const out: ObjectStat[] = [];
    let token: string | undefined;
    do {
      const result = (await this.client.send(
        new this.commands.ListObjectsV2Command({
          Bucket: this.bucket,
          Prefix: this.absolute(prefix),
          ...(token ? { ContinuationToken: token } : {}),
        }),
      )) as {
        Contents?: readonly { Key?: string; LastModified?: Date }[];
        NextContinuationToken?: string;
        IsTruncated?: boolean;
      };
      for (const object of result.Contents ?? []) {
        if (!object.Key) {
          continue;
        }
        const relative = this.rootPrefix
          ? object.Key.slice(this.rootPrefix.length + 1)
          : object.Key;
        out.push({ key: relative, lastModified: object.LastModified?.getTime() ?? 0 });
      }
      token = result.IsTruncated ? result.NextContinuationToken : undefined;
    } while (token);
    return out;
  }
}

export interface ParsedDataPlaneUri {
  readonly kind: 's3' | 'file';
  /** Bucket for s3, absolute-or-relative root path for file. */
  readonly bucket?: string;
  readonly prefix: string;
}

/** `s3://bucket/prefix` → s3; anything else is a local directory path. */
export function parseDataPlaneUri(uri: string): ParsedDataPlaneUri {
  const match = uri.match(/^s3:\/\/([^/]+)\/?(.*)$/);
  if (match) {
    if (!match[1]) {
      throw new ObjectStoreError(`data-plane URI "${uri}" names no bucket`);
    }
    return { kind: 's3', bucket: match[1], prefix: match[2].replace(/\/+$/, '') };
  }
  return { kind: 'file', prefix: uri };
}
