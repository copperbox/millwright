/** Reference to a secret a job receives as an environment variable. */
export class Secret {
  /**
   * A millwright-managed secret, resolved at dispatch from
   * `/millwright/<deployment>/secrets/<scope>/<name>`. Scope defaults to the
   * repo the run belongs to; pass an explicit `scope` for shared secrets.
   */
  static named(name: string, options: { readonly scope?: string } = {}): Secret {
    if (!name || !name.trim()) {
      throw new Error('Secret.named requires a non-empty name');
    }
    return new Secret('named', name, options.scope);
  }

  /** Passthrough reference to an existing Secrets Manager secret ARN. */
  static fromSecretsManager(arn: string): Secret {
    if (!arn.startsWith('arn:')) {
      throw new Error(`Secret.fromSecretsManager expects a Secrets Manager ARN, got "${arn}"`);
    }
    return new Secret('secrets-manager', arn);
  }

  private constructor(
    readonly kind: 'named' | 'secrets-manager',
    readonly ref: string,
    readonly scope?: string,
  ) {}
}

/** Declares what a job produces; consuming it elsewhere is the DAG edge. */
export class Artifact {
  /** A directory produced by the job, uploaded recursively. */
  static dir(path: string): Artifact {
    return new Artifact('dir', path);
  }

  /** A single file produced by the job. */
  static file(path: string): Artifact {
    return new Artifact('file', path);
  }

  private constructor(
    readonly kind: 'dir' | 'file',
    readonly path: string,
  ) {
    if (!path || !path.trim()) {
      throw new Error('Artifact requires a non-empty path');
    }
  }
}

/**
 * Deferred file-hash token for cache keys. Hashing happens at synth against
 * the checked-out source; the definition only records the patterns.
 */
export class HashFilesToken {
  constructor(readonly patterns: readonly string[]) {
    if (patterns.length === 0) {
      throw new Error('hashFiles requires at least one file pattern');
    }
  }
}

/** Cache key fragments: literal strings and deferred hashFiles() tokens. */
export type CacheKeyPart = string | HashFilesToken;

export function hashFiles(...patterns: string[]): HashFilesToken {
  return new HashFilesToken(patterns);
}

export interface KeyedCacheOptions {
  readonly key: CacheKeyPart | readonly CacheKeyPart[];
  readonly paths: readonly string[];
  readonly restoreKeys?: readonly string[];
}

/** Keyed dependency cache backed by the deployment's artifact/cache bucket. */
export class Cache {
  static keyed(options: KeyedCacheOptions): Cache {
    if (!options.paths || options.paths.length === 0) {
      throw new Error('Cache.keyed requires at least one path');
    }
    const key = Array.isArray(options.key) ? options.key : [options.key as CacheKeyPart];
    return new Cache(key, options.paths, options.restoreKeys ?? []);
  }

  private constructor(
    readonly key: readonly CacheKeyPart[],
    readonly paths: readonly string[],
    readonly restoreKeys: readonly string[],
  ) {}
}

export type ComputeArch = 'arm64' | 'x86_64';
export type ComputeSize = 'small' | 'medium' | 'large';

/** CodeBuild sizing. ARM small is the fleet default; x86 is the opt-in. */
export class Compute {
  static readonly ARM_SMALL = new Compute('arm64', 'small');
  static readonly ARM_MEDIUM = new Compute('arm64', 'medium');
  static readonly ARM_LARGE = new Compute('arm64', 'large');
  static readonly X86_SMALL = new Compute('x86_64', 'small');
  static readonly X86_MEDIUM = new Compute('x86_64', 'medium');
  static readonly X86_LARGE = new Compute('x86_64', 'large');

  private constructor(
    readonly arch: ComputeArch,
    readonly size: ComputeSize,
  ) {}
}

export interface StepOptions {
  /**
   * Shell command evaluated before the step; exit 0 marks the step SKIPPED
   * (reason: skip_if) and the job continues.
   */
  readonly skipIf?: string;
}

/** One shell step. Plain strings are accepted anywhere a Step is. */
export class Step {
  static run(command: string, options: StepOptions = {}): Step {
    return new Step(command, options.skipIf);
  }

  private constructor(
    readonly command: string,
    readonly skipIf?: string,
  ) {
    if (!command || !command.trim()) {
      throw new Error('Step.run requires a non-empty command');
    }
  }
}

/** Steps as authored: strings, Step objects, or an inputs-driven factory. */
export type StepInput = string | Step;
export type StepsProp = readonly StepInput[] | ((inputs: Record<string, unknown>) => readonly StepInput[]);
