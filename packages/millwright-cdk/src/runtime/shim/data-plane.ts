import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { CACHE_URI_ENV, OUT_URI_ENV } from '@copperbox/millwright-state';
import { ObjectStore, ObjectStoreError, ObjectStat } from './object-store';
import { TarEntry, TarError, extractTarGz, packTarGz } from './tar';

/**
 * The shim's data-plane subcommands (spec §12, §11.2) — the runtime half of
 * artifacts and keyed caches. Invocation shapes are authored in ONE place,
 * the shared buildspec renderer in `@copperbox/millwright-state`:
 *
 *     millwright-shim source unpack --archive source.tar.gz
 *     millwright-shim artifact fetch --job <job> --name <name>
 *     millwright-shim artifact upload --name <name> --path <p> [--path <p>]…
 *     millwright-shim cache restore --key <k> [--restore-key <r>]… --path <p>…
 *     millwright-shim cache save --key <k> --path <p>…
 *
 * Write confinement is by construction: `artifact upload` derives its
 * destination from the job's OWN dispatch identity (`MILLWRIGHT_JOB`) — the
 * renderer-authored argv has no flag naming another job's subtree — and the
 * job role's IAM policy (§10.2) is the enforcement underneath for anything
 * that bypasses the shim. `artifact fetch` names any producer: run-wide
 * artifact READ is granted deliberately.
 *
 * Cache semantics are GHA-keyed (§12): restore tries the exact key, then
 * each `restoreKeys` prefix in order (newest object wins within a prefix);
 * an exact hit drops a marker file that turns the post-build `save` into a
 * no-op. Save also skips when the exact key already exists remotely — any
 * branch computes the shared key legitimately (write trust is repo-scoped),
 * so re-uploading an identical archive is pure waste.
 */

/** Job identity env var, set by the dispatcher alongside MILLWRIGHT_RUN_ID. */
export const JOB_NAME_ENV = 'MILLWRIGHT_JOB';

/** Sysexits-style usage/config exit — argv authored by the renderer never hits it. */
export const DATA_PLANE_USAGE_EXIT_CODE = 64;

export class DataPlaneError extends Error {}

export type ParsedDataPlane =
  | { readonly kind: 'source-unpack'; readonly archive: string }
  | { readonly kind: 'artifact-fetch'; readonly job: string; readonly name: string }
  | { readonly kind: 'artifact-upload'; readonly name: string; readonly paths: readonly string[] }
  | {
      readonly kind: 'cache-restore';
      readonly key: string;
      readonly restoreKeys: readonly string[];
      readonly paths: readonly string[];
    }
  | { readonly kind: 'cache-save'; readonly key: string; readonly paths: readonly string[] }
  | { readonly kind: 'error'; readonly message: string };

interface Flags {
  readonly single: Record<string, string>;
  readonly multi: Record<string, string[]>;
}

function parseFlags(
  rest: readonly string[],
  singleNames: readonly string[],
  multiNames: readonly string[],
): Flags | string {
  const single: Record<string, string> = {};
  const multi: Record<string, string[]> = {};
  for (let i = 0; i < rest.length; i += 1) {
    const flag = rest[i];
    const value = rest[i + 1];
    if (value === undefined) {
      return `${flag} requires a value`;
    }
    i += 1;
    const name = flag.replace(/^--/, '');
    if (singleNames.includes(name)) {
      if (single[name] !== undefined) {
        return `duplicate ${flag}`;
      }
      single[name] = value;
    } else if (multiNames.includes(name)) {
      (multi[name] ??= []).push(value);
    } else {
      return `unknown flag "${flag}"`;
    }
  }
  return { single, multi };
}

/** Parse a full data-plane argv (`['artifact', 'fetch', …]`). */
export function parseDataPlaneCli(argv: readonly string[]): ParsedDataPlane {
  const [command, action, ...rest] = argv;
  const fail = (message: string): ParsedDataPlane => ({ kind: 'error', message });

  if (command === 'source') {
    if (action !== 'unpack') {
      return fail(`unknown source action "${action}"`);
    }
    const flags = parseFlags(rest, ['archive'], []);
    if (typeof flags === 'string') {
      return fail(flags);
    }
    return flags.single.archive
      ? { kind: 'source-unpack', archive: flags.single.archive }
      : fail('source unpack requires --archive');
  }

  if (command === 'artifact') {
    if (action === 'fetch') {
      const flags = parseFlags(rest, ['job', 'name'], []);
      if (typeof flags === 'string') {
        return fail(flags);
      }
      return flags.single.job && flags.single.name
        ? { kind: 'artifact-fetch', job: flags.single.job, name: flags.single.name }
        : fail('artifact fetch requires --job and --name');
    }
    if (action === 'upload') {
      const flags = parseFlags(rest, ['name'], ['path']);
      if (typeof flags === 'string') {
        return fail(flags);
      }
      return flags.single.name && (flags.multi.path?.length ?? 0) > 0
        ? { kind: 'artifact-upload', name: flags.single.name, paths: flags.multi.path }
        : fail('artifact upload requires --name and at least one --path');
    }
    return fail(`unknown artifact action "${action}"`);
  }

  if (command === 'cache') {
    if (action !== 'restore' && action !== 'save') {
      return fail(`unknown cache action "${action}"`);
    }
    const flags = parseFlags(rest, ['key'], ['restore-key', 'path']);
    if (typeof flags === 'string') {
      return fail(flags);
    }
    if (!flags.single.key || (flags.multi.path?.length ?? 0) === 0) {
      return fail(`cache ${action} requires --key and at least one --path`);
    }
    if (action === 'restore') {
      return {
        kind: 'cache-restore',
        key: flags.single.key,
        restoreKeys: flags.multi['restore-key'] ?? [],
        paths: flags.multi.path,
      };
    }
    return { kind: 'cache-save', key: flags.single.key, paths: flags.multi.path };
  }

  return fail(`unknown data-plane command "${command}"`);
}

export interface DataPlaneDeps {
  /** The job's working directory (the unpacked source root). */
  readonly workdir: string;
  /** Store rooted at the run's `out/` prefix. */
  readonly outStore?: ObjectStore;
  /** Store rooted at the repo's `cache/<repo>/` prefix. */
  readonly cacheStore?: ObjectStore;
  /** This job's dispatch identity — the ONLY writable `out/` subtree. */
  readonly jobName?: string;
  /** Exact-hit marker directory; defaults to the OS tmpdir in the host wiring. */
  readonly markerDir: string;
  readonly log: (message: string) => void;
}

/** A workspace-relative path from the model: no escape from the workdir. */
function assertWorkspaceRelative(what: string, value: string): void {
  const segments = value.split('/');
  if (
    !value ||
    value.startsWith('/') ||
    /^[a-zA-Z]:/.test(value) ||
    segments.some((s) => s === '' || s === '..')
  ) {
    throw new DataPlaneError(`${what} "${value}" must be a workspace-relative path`);
  }
}

function assertSegment(what: string, value: string): void {
  if (!value || value.includes('/') || value === '.' || value === '..') {
    throw new DataPlaneError(`${what} "${value}" must be a single path segment`);
  }
}

/** Walk one declared path into tar-shaped entries, workdir-relative. */
function collectEntries(workdir: string, relPath: string): TarEntry[] {
  const abs = path.join(workdir, ...relPath.split('/'));
  let stat: fs.Stats;
  try {
    stat = fs.lstatSync(abs);
  } catch {
    return [];
  }
  if (stat.isSymbolicLink()) {
    return [
      {
        path: relPath,
        type: 'symlink',
        content: Buffer.alloc(0),
        linkTarget: fs.readlinkSync(abs),
      },
    ];
  }
  if (stat.isFile()) {
    return [
      {
        path: relPath,
        type: 'file',
        content: fs.readFileSync(abs),
        executable: (stat.mode & 0o100) !== 0,
      },
    ];
  }
  if (stat.isDirectory()) {
    const entries: TarEntry[] = [{ path: relPath, type: 'dir', content: Buffer.alloc(0) }];
    for (const name of fs.readdirSync(abs).sort()) {
      entries.push(...collectEntries(workdir, `${relPath}/${name}`));
    }
    return entries;
  }
  return [];
}

/** Write extracted entries into the workdir, restoring exec bits and links. */
function materializeEntries(workdir: string, entries: readonly TarEntry[]): void {
  for (const entry of entries) {
    const target = path.join(workdir, ...entry.path.split('/'));
    if (entry.type === 'dir') {
      fs.mkdirSync(target, { recursive: true });
      continue;
    }
    fs.mkdirSync(path.dirname(target), { recursive: true });
    if (entry.type === 'symlink') {
      fs.rmSync(target, { force: true });
      fs.symlinkSync(entry.linkTarget ?? '', target);
      continue;
    }
    fs.writeFileSync(target, entry.content);
    if (entry.executable) {
      fs.chmodSync(target, 0o755);
    }
  }
}

function markerPath(deps: DataPlaneDeps, key: string): string {
  const digest = createHash('sha256').update(key).digest('hex').slice(0, 32);
  return path.join(deps.markerDir, `millwright-cache-hit-${digest}`);
}

function requireStore(store: ObjectStore | undefined, envName: string): ObjectStore {
  if (!store) {
    throw new DataPlaneError(`${envName} is not set — the dispatcher provides it`);
  }
  return store;
}

async function sourceUnpack(deps: DataPlaneDeps, archive: string): Promise<void> {
  assertWorkspaceRelative('archive', archive);
  const archivePath = path.join(deps.workdir, ...archive.split('/'));
  let body: Buffer;
  try {
    body = fs.readFileSync(archivePath);
  } catch {
    throw new DataPlaneError(
      `no ${archive} in the workdir — the primary source should have delivered it`,
    );
  }
  const entries = extractTarGz(body);
  materializeEntries(deps.workdir, entries);
  deps.log(`unpacked ${archive} (${entries.length} entries)`);
}

async function artifactUpload(
  deps: DataPlaneDeps,
  name: string,
  paths: readonly string[],
): Promise<void> {
  const store = requireStore(deps.outStore, OUT_URI_ENV);
  if (!deps.jobName) {
    throw new DataPlaneError(`${JOB_NAME_ENV} is not set — the dispatcher provides it`);
  }
  assertSegment('job name', deps.jobName);
  assertSegment('artifact name', name);

  let uploaded = 0;
  for (const declared of paths) {
    assertWorkspaceRelative('artifact path', declared);
    const entries = collectEntries(deps.workdir, declared);
    const files = entries.filter((entry) => entry.type === 'file');
    if (entries.length === 0) {
      throw new DataPlaneError(
        `declared artifact path "${declared}" does not exist — the job declared "${name}" ` +
          'but produced nothing there',
      );
    }
    for (const file of files) {
      // Confinement by construction: the destination starts with THIS job's
      // dispatch identity; no argv can point the upload elsewhere.
      await store.put(`${deps.jobName}/${name}/${file.path}`, file.content);
      uploaded += 1;
    }
  }
  if (uploaded === 0) {
    throw new DataPlaneError(
      `artifact "${name}" matched no files — declared paths [${paths.join(', ')}] are empty`,
    );
  }
  deps.log(`uploaded artifact ${name} (${uploaded} files)`);
}

async function artifactFetch(deps: DataPlaneDeps, job: string, name: string): Promise<void> {
  const store = requireStore(deps.outStore, OUT_URI_ENV);
  assertSegment('job name', job);
  assertSegment('artifact name', name);
  const prefix = `${job}/${name}/`;
  const objects = await store.list(prefix);
  if (objects.length === 0) {
    throw new DataPlaneError(
      `artifact "${name}" of job "${job}" has no objects under out/${prefix} — ` +
        'its producing job should have uploaded before this job dispatched',
    );
  }
  for (const object of objects) {
    const relative = object.key.slice(prefix.length);
    assertWorkspaceRelative('fetched artifact path', relative);
    const body = await store.get(object.key);
    if (body === undefined) {
      throw new DataPlaneError(`object ${object.key} vanished during fetch`);
    }
    materializeEntries(deps.workdir, [
      { path: relative, type: 'file', content: body },
    ]);
  }
  deps.log(`fetched artifact ${name} from ${job} (${objects.length} files)`);
}

function newestMatch(objects: readonly ObjectStat[]): ObjectStat | undefined {
  return [...objects].sort((a, b) => b.lastModified - a.lastModified)[0];
}

async function cacheRestore(
  deps: DataPlaneDeps,
  key: string,
  restoreKeys: readonly string[],
): Promise<void> {
  const store = requireStore(deps.cacheStore, CACHE_URI_ENV);

  const exact = await store.get(key);
  if (exact !== undefined) {
    materializeEntries(deps.workdir, extractTarGz(exact));
    // The exact-hit marker is what turns the post-build save into a no-op.
    fs.mkdirSync(deps.markerDir, { recursive: true });
    fs.writeFileSync(markerPath(deps, key), key);
    deps.log(`cache exact hit on "${key}"`);
    return;
  }

  for (const restoreKey of restoreKeys) {
    const candidate = newestMatch(await store.list(restoreKey));
    if (!candidate) {
      continue;
    }
    const body = await store.get(candidate.key);
    if (body === undefined) {
      continue; // evicted between list and get — try the next prefix
    }
    materializeEntries(deps.workdir, extractTarGz(body));
    deps.log(`cache restored "${candidate.key}" via restore key "${restoreKey}"`);
    return;
  }
  deps.log(`cache miss on "${key}" (${restoreKeys.length} restore keys tried)`);
}

async function cacheSave(deps: DataPlaneDeps, key: string, paths: readonly string[]): Promise<void> {
  const store = requireStore(deps.cacheStore, CACHE_URI_ENV);

  if (fs.existsSync(markerPath(deps, key))) {
    deps.log(`cache save skipped — restore hit "${key}" exactly`);
    return;
  }
  // Another run may have raced the same key (any branch computes the shared
  // key legitimately — §10.2); the first writer wins and the rest skip.
  const existing = await store.list(key);
  if (existing.some((object) => object.key === key)) {
    deps.log(`cache save skipped — "${key}" already exists`);
    return;
  }

  const entries: TarEntry[] = [];
  for (const declared of paths) {
    assertWorkspaceRelative('cache path', declared);
    entries.push(...collectEntries(deps.workdir, declared));
  }
  if (entries.length === 0) {
    // A missing cache dir on a green build is a warning, not a failure —
    // failing post_build here would fail a job whose steps all succeeded.
    deps.log(`cache save skipped — paths [${paths.join(', ')}] matched nothing`);
    return;
  }
  await store.put(key, packTarGz(entries));
  deps.log(`cache saved "${key}" (${entries.length} entries)`);
}

/**
 * Execute one parsed data-plane command; returns the process exit code.
 * Restore misses and save skips are successes; broken configuration and
 * missing declared artifacts fail the build.
 */
export async function runDataPlane(
  parsed: Exclude<ParsedDataPlane, { kind: 'error' }>,
  deps: DataPlaneDeps,
): Promise<number> {
  try {
    switch (parsed.kind) {
      case 'source-unpack':
        await sourceUnpack(deps, parsed.archive);
        return 0;
      case 'artifact-fetch':
        await artifactFetch(deps, parsed.job, parsed.name);
        return 0;
      case 'artifact-upload':
        await artifactUpload(deps, parsed.name, parsed.paths);
        return 0;
      case 'cache-restore':
        await cacheRestore(deps, parsed.key, parsed.restoreKeys);
        return 0;
      case 'cache-save':
        await cacheSave(deps, parsed.key, parsed.paths);
        return 0;
    }
  } catch (err) {
    if (err instanceof DataPlaneError || err instanceof TarError || err instanceof ObjectStoreError) {
      deps.log(`millwright-shim: ${err.message}`);
      return 1;
    }
    throw err;
  }
}

/** Marker directory default for host wiring. */
export function defaultMarkerDir(): string {
  return os.tmpdir();
}
