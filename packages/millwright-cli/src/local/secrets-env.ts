import * as fs from 'node:fs';
import { RunModelJob, RunModelSecret, isReservedEnvName } from '@copperbox/millwright-state';
import { CommandError } from '../config-plane';

/**
 * Local secrets (spec §14): the same env-var contract as the cloud's
 * SSM/Secrets Manager injection, with values from a gitignored
 * `.millwright/secrets.env` (or `--secrets-file`). Millwright makes zero
 * AWS calls locally — parity stops at the env-var boundary — and missing
 * declared secrets fail before any job starts, naming what is needed.
 */

/** Parse a dotenv-shaped file: KEY=VALUE lines, #-comments, optional quotes. */
export function parseEnvFile(content: string): Record<string, string> {
  const values: Record<string, string> = {};
  for (const rawLine of content.split('\n')) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) {
      continue;
    }
    const separator = line.indexOf('=');
    if (separator < 1) {
      continue;
    }
    const key = line.slice(0, separator).trim();
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) {
      continue;
    }
    let value = line.slice(separator + 1).trim();
    if (
      value.length >= 2 &&
      ((value.startsWith('"') && value.endsWith('"')) ||
        (value.startsWith("'") && value.endsWith("'")))
    ) {
      value = value.slice(1, -1);
    }
    values[key] = value;
  }
  return values;
}

export interface LocalSecretsSource {
  /** Path actually read, when one existed. */
  readonly path?: string;
  readonly values: Readonly<Record<string, string>>;
}

/**
 * Load the local secrets file. An explicit `--secrets-file` must exist; the
 * default `.millwright/secrets.env` is optional (absent = no secrets).
 */
export function loadLocalSecrets(
  explicitPath: string | undefined,
  defaultPath: string,
): LocalSecretsSource {
  const chosen = explicitPath ?? defaultPath;
  let content: string;
  try {
    content = fs.readFileSync(chosen, 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
      if (explicitPath) {
        throw new CommandError(`secrets file ${explicitPath} does not exist`);
      }
      return { values: {} };
    }
    throw err;
  }
  return { path: chosen, values: parseEnvFile(content) };
}

function describeRef(ref: RunModelSecret): string {
  if ('parameter' in ref) {
    return `Secret.named('${ref.parameter}')`;
  }
  return 'Secrets Manager passthrough';
}

export interface MissingSecret {
  readonly job: string;
  readonly env: string;
  readonly ref: string;
}

/**
 * Preflight (fail-closed, before anything runs): every secret env var the
 * jobs to be executed declare must resolve from the secrets source. Reserved
 * env names are dropped at render/dispatch in the cloud and skipped here too.
 */
export function missingSecrets(
  jobs: readonly RunModelJob[],
  source: LocalSecretsSource,
): MissingSecret[] {
  const missing: MissingSecret[] = [];
  for (const job of jobs) {
    for (const [env, ref] of Object.entries(job.secrets ?? {})) {
      if (isReservedEnvName(env)) {
        continue;
      }
      if (source.values[env] === undefined) {
        missing.push({ job: job.name, env, ref: describeRef(ref) });
      }
    }
  }
  return missing;
}

/** The secret env entries one job receives, from the loaded source. */
export function secretEnvForJob(
  job: RunModelJob,
  source: LocalSecretsSource,
): Record<string, string> {
  const env: Record<string, string> = {};
  for (const name of Object.keys(job.secrets ?? {})) {
    if (isReservedEnvName(name)) {
      continue;
    }
    const value = source.values[name];
    if (value !== undefined) {
      env[name] = value;
    }
  }
  return env;
}
