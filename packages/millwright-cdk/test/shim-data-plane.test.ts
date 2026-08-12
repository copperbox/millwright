import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  DataPlaneDeps,
  parseDataPlaneCli,
  runDataPlane,
} from '../src/runtime/shim/data-plane';
import { FileObjectStore } from '../src/runtime/shim/object-store';
import { packTarGz } from '../src/runtime/shim/tar';

const tmpdirs: string[] = [];

function tmp(prefix = 'millwright-dp-'): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tmpdirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of tmpdirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

interface Harness {
  readonly deps: DataPlaneDeps;
  readonly outRoot: string;
  readonly cacheRoot: string;
  readonly workdir: string;
  readonly logs: string[];
}

/** One job's view of the data plane, filesystem-backed like the local runner. */
function harness(jobName: string, shared?: { outRoot?: string; cacheRoot?: string }): Harness {
  const outRoot = shared?.outRoot ?? tmp('millwright-out-');
  const cacheRoot = shared?.cacheRoot ?? tmp('millwright-cache-');
  const workdir = tmp('millwright-work-');
  const logs: string[] = [];
  return {
    outRoot,
    cacheRoot,
    workdir,
    logs,
    deps: {
      workdir,
      outStore: new FileObjectStore(outRoot),
      cacheStore: new FileObjectStore(cacheRoot),
      jobName,
      markerDir: tmp('millwright-marker-'),
      log: (message) => logs.push(message),
    },
  };
}

async function run(deps: DataPlaneDeps, argv: string[]): Promise<number> {
  const parsed = parseDataPlaneCli(argv);
  if (parsed.kind === 'error') {
    throw new Error(`unexpected parse error: ${parsed.message}`);
  }
  return runDataPlane(parsed, deps);
}

function write(workdir: string, rel: string, content: string, mode?: number): void {
  const abs = path.join(workdir, ...rel.split('/'));
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, content, mode !== undefined ? { mode } : {});
}

describe('parseDataPlaneCli', () => {
  it('parses every renderer-authored shape', () => {
    expect(parseDataPlaneCli(['source', 'unpack', '--archive', 'source.tar.gz'])).toEqual({
      kind: 'source-unpack',
      archive: 'source.tar.gz',
    });
    expect(parseDataPlaneCli(['artifact', 'fetch', '--job', 'build', '--name', 'dist'])).toEqual({
      kind: 'artifact-fetch',
      job: 'build',
      name: 'dist',
    });
    expect(
      parseDataPlaneCli(['artifact', 'upload', '--name', 'dist', '--path', 'dist', '--path', 'lib']),
    ).toEqual({ kind: 'artifact-upload', name: 'dist', paths: ['dist', 'lib'] });
    expect(
      parseDataPlaneCli([
        'cache', 'restore',
        '--key', 'npm-abc',
        '--restore-key', 'npm-',
        '--restore-key', 'n-',
        '--path', 'node_modules',
      ]),
    ).toEqual({
      kind: 'cache-restore',
      key: 'npm-abc',
      restoreKeys: ['npm-', 'n-'],
      paths: ['node_modules'],
    });
    expect(parseDataPlaneCli(['cache', 'save', '--key', 'npm-abc', '--path', 'node_modules'])).toEqual(
      { kind: 'cache-save', key: 'npm-abc', paths: ['node_modules'] },
    );
  });

  it('rejects unknown commands, missing values and missing required flags', () => {
    expect(parseDataPlaneCli(['cache', 'purge'])).toMatchObject({ kind: 'error' });
    expect(parseDataPlaneCli(['artifact', 'upload', '--name'])).toMatchObject({ kind: 'error' });
    expect(parseDataPlaneCli(['artifact', 'upload', '--path', 'x'])).toMatchObject({
      kind: 'error',
    });
    expect(parseDataPlaneCli(['cache', 'restore', '--key', 'k'])).toMatchObject({ kind: 'error' });
    expect(parseDataPlaneCli(['blob', 'up'])).toMatchObject({ kind: 'error' });
  });
});

describe('artifact flow — the acceptance path', () => {
  it('producer uploads out/<job>/<artifact>/…, consumer fetches it back', async () => {
    const producer = harness('build');
    write(producer.workdir, 'dist/app.js', 'bundle');
    write(producer.workdir, 'dist/assets/logo.svg', '<svg/>');
    expect(await run(producer.deps, ['artifact', 'upload', '--name', 'dist', '--path', 'dist'])).toBe(0);

    // Objects land under the producer's own out/<job>/ subtree.
    expect(
      fs.readFileSync(path.join(producer.outRoot, 'build', 'dist', 'dist', 'app.js'), 'utf8'),
    ).toBe('bundle');

    const consumer = harness('integration', { outRoot: producer.outRoot });
    expect(await run(consumer.deps, ['artifact', 'fetch', '--job', 'build', '--name', 'dist'])).toBe(0);
    expect(fs.readFileSync(path.join(consumer.workdir, 'dist', 'app.js'), 'utf8')).toBe('bundle');
    expect(
      fs.readFileSync(path.join(consumer.workdir, 'dist', 'assets', 'logo.svg'), 'utf8'),
    ).toBe('<svg/>');
  });

  it('uploads single-file artifacts and multiple declared paths', async () => {
    const producer = harness('build');
    write(producer.workdir, 'coverage/report.xml', '<xml/>');
    write(producer.workdir, 'summary.txt', 'ok');
    expect(
      await run(producer.deps, [
        'artifact', 'upload', '--name', 'report',
        '--path', 'coverage/report.xml', '--path', 'summary.txt',
      ]),
    ).toBe(0);
    const consumer = harness('publish', { outRoot: producer.outRoot });
    expect(await run(consumer.deps, ['artifact', 'fetch', '--job', 'build', '--name', 'report'])).toBe(0);
    expect(fs.readFileSync(path.join(consumer.workdir, 'summary.txt'), 'utf8')).toBe('ok');
  });

  it('a write outside the job own out/<job>/ subtree is impossible to express and denied', async () => {
    const h = harness('build');
    write(h.workdir, 'dist/app.js', 'x');
    // There is no --job flag on upload: the destination derives from the
    // dispatch identity. Hostile names trying to smuggle separators fail.
    expect(await run(h.deps, ['artifact', 'upload', '--name', '../other-job', '--path', 'dist'])).toBe(1);
    expect(await run(h.deps, ['artifact', 'upload', '--name', 'a/b', '--path', 'dist'])).toBe(1);
    expect(await run(h.deps, ['artifact', 'upload', '--name', 'dist', '--path', '../outside'])).toBe(1);
    expect(await run(h.deps, ['artifact', 'upload', '--name', 'dist', '--path', '/etc'])).toBe(1);
    // Nothing landed outside build/ in the out root.
    expect(fs.readdirSync(h.outRoot)).toEqual([]);

    // A forged job identity is the dispatcher's to prevent; a multi-segment
    // one from a broken dispatch still refuses to run.
    const forged = harness('build');
    write(forged.workdir, 'dist/app.js', 'x');
    expect(
      await run(
        { ...forged.deps, jobName: 'build/../other' },
        ['artifact', 'upload', '--name', 'dist', '--path', 'dist'],
      ),
    ).toBe(1);
  });

  it('fails loud when a declared artifact produced nothing', async () => {
    const h = harness('build');
    expect(await run(h.deps, ['artifact', 'upload', '--name', 'dist', '--path', 'dist'])).toBe(1);
    expect(h.logs.join('\n')).toContain('produced nothing');

    const consumer = harness('it', { outRoot: h.outRoot });
    expect(await run(consumer.deps, ['artifact', 'fetch', '--job', 'build', '--name', 'dist'])).toBe(1);
    expect(consumer.logs.join('\n')).toContain('no objects');
  });

  it('materializes loose-object artifacts without modes — the documented v1 limit', async () => {
    const producer = harness('build');
    write(producer.workdir, 'bin/run', '#!/bin/sh\n', 0o755);
    expect(await run(producer.deps, ['artifact', 'upload', '--name', 'bin', '--path', 'bin'])).toBe(0);
    // Loose-object artifacts do not carry modes (documented v1 limit) —
    // the fetched file exists with default permissions.
    const consumer = harness('deploy', { outRoot: producer.outRoot });
    expect(await run(consumer.deps, ['artifact', 'fetch', '--job', 'build', '--name', 'bin'])).toBe(0);
    expect(fs.existsSync(path.join(consumer.workdir, 'bin', 'run'))).toBe(true);
  });
});

describe('cache flow — the acceptance path', () => {
  it('save then exact-hit restore, and the exact hit skips the next save', async () => {
    const first = harness('build');
    write(first.workdir, 'node_modules/pkg/index.js', 'v1');
    expect(await run(first.deps, ['cache', 'save', '--key', 'npm-abc', '--path', 'node_modules'])).toBe(0);
    expect(fs.existsSync(path.join(first.cacheRoot, 'npm-abc'))).toBe(true);

    const second = harness('build', { cacheRoot: first.cacheRoot });
    expect(
      await run(second.deps, [
        'cache', 'restore', '--key', 'npm-abc', '--restore-key', 'npm-', '--path', 'node_modules',
      ]),
    ).toBe(0);
    expect(
      fs.readFileSync(path.join(second.workdir, 'node_modules', 'pkg', 'index.js'), 'utf8'),
    ).toBe('v1');
    expect(second.logs.join('\n')).toContain('exact hit');

    // The marker makes the post-build save a no-op.
    const before = fs.statSync(path.join(first.cacheRoot, 'npm-abc')).mtimeMs;
    expect(await run(second.deps, ['cache', 'save', '--key', 'npm-abc', '--path', 'node_modules'])).toBe(0);
    expect(second.logs.join('\n')).toContain('save skipped — restore hit');
    expect(fs.statSync(path.join(first.cacheRoot, 'npm-abc')).mtimeMs).toBe(before);
  });

  it('falls back through restoreKeys prefixes in order, newest object first', async () => {
    const seeder = harness('build');
    write(seeder.workdir, 'node_modules/old/x.js', 'old');
    expect(await run(seeder.deps, ['cache', 'save', '--key', 'npm-old1', '--path', 'node_modules'])).toBe(0);
    fs.rmSync(path.join(seeder.workdir, 'node_modules'), { recursive: true });
    write(seeder.workdir, 'node_modules/new/x.js', 'new');
    // Distinct mtimes even on coarse-grained filesystems.
    expect(await run(seeder.deps, ['cache', 'save', '--key', 'npm-new2', '--path', 'node_modules'])).toBe(0);
    const later = Date.now() + 5_000;
    fs.utimesSync(path.join(seeder.cacheRoot, 'npm-new2'), new Date(later), new Date(later));

    const restorer = harness('build', { cacheRoot: seeder.cacheRoot });
    expect(
      await run(restorer.deps, [
        'cache', 'restore', '--key', 'npm-missing',
        '--restore-key', 'zzz-', '--restore-key', 'npm-',
        '--path', 'node_modules',
      ]),
    ).toBe(0);
    expect(restorer.logs.join('\n')).toContain('restored "npm-new2" via restore key "npm-"');
    expect(fs.existsSync(path.join(restorer.workdir, 'node_modules', 'new', 'x.js'))).toBe(true);
    expect(fs.existsSync(path.join(restorer.workdir, 'node_modules', 'old', 'x.js'))).toBe(false);

    // A restore-key hit is NOT an exact hit: the following save proceeds.
    write(restorer.workdir, 'node_modules/extra.js', 'x');
    expect(
      await run(restorer.deps, ['cache', 'save', '--key', 'npm-missing', '--path', 'node_modules']),
    ).toBe(0);
    expect(fs.existsSync(path.join(seeder.cacheRoot, 'npm-missing'))).toBe(true);
  });

  it('a miss is quiet and save skips when the key already exists remotely', async () => {
    const h = harness('build');
    expect(
      await run(h.deps, ['cache', 'restore', '--key', 'none', '--restore-key', 'no-', '--path', 'x']),
    ).toBe(0);
    expect(h.logs.join('\n')).toContain('cache miss');

    // Another run raced the same key: first writer wins.
    fs.writeFileSync(path.join(h.cacheRoot, 'raced'), packTarGz([]));
    write(h.workdir, 'node_modules/x.js', 'mine');
    expect(await run(h.deps, ['cache', 'save', '--key', 'raced', '--path', 'node_modules'])).toBe(0);
    expect(h.logs.join('\n')).toContain('already exists');
  });

  it('save with nothing to pack warns and succeeds — a green job stays green', async () => {
    const h = harness('build');
    expect(await run(h.deps, ['cache', 'save', '--key', 'k1', '--path', 'node_modules'])).toBe(0);
    expect(h.logs.join('\n')).toContain('matched nothing');
    expect(fs.existsSync(path.join(h.cacheRoot, 'k1'))).toBe(false);
  });

  it('round-trips executable bits and symlinks through the cache archive', async () => {
    const producer = harness('build');
    write(producer.workdir, 'node_modules/.bin/tool', '#!/bin/sh\n', 0o755);
    fs.symlinkSync(
      '../pkg/cli.js',
      path.join(producer.workdir, 'node_modules', '.bin', 'linked'),
    );
    write(producer.workdir, 'node_modules/pkg/cli.js', 'cli');
    expect(await run(producer.deps, ['cache', 'save', '--key', 'k', '--path', 'node_modules'])).toBe(0);

    const restorer = harness('build', { cacheRoot: producer.cacheRoot });
    expect(await run(restorer.deps, ['cache', 'restore', '--key', 'k', '--path', 'node_modules'])).toBe(0);
    const tool = path.join(restorer.workdir, 'node_modules', '.bin', 'tool');
    expect(fs.statSync(tool).mode & 0o100).not.toBe(0);
    const linked = path.join(restorer.workdir, 'node_modules', '.bin', 'linked');
    expect(fs.readlinkSync(linked)).toBe('../pkg/cli.js');
  });
});

describe('source unpack', () => {
  it('unpacks source.tar.gz from the workdir into the workdir', async () => {
    const h = harness('build');
    const archive = packTarGz([
      { path: 'src', type: 'dir', content: Buffer.alloc(0) },
      { path: 'src/index.ts', type: 'file', content: Buffer.from('export {}') },
      { path: 'run.sh', type: 'file', content: Buffer.from('#!/bin/sh\n'), executable: true },
    ]);
    fs.writeFileSync(path.join(h.workdir, 'source.tar.gz'), archive);
    expect(await run(h.deps, ['source', 'unpack', '--archive', 'source.tar.gz'])).toBe(0);
    expect(fs.readFileSync(path.join(h.workdir, 'src', 'index.ts'), 'utf8')).toBe('export {}');
    expect(fs.statSync(path.join(h.workdir, 'run.sh')).mode & 0o100).not.toBe(0);
  });

  it('fails loud when the archive is missing', async () => {
    const h = harness('build');
    expect(await run(h.deps, ['source', 'unpack', '--archive', 'source.tar.gz'])).toBe(1);
    expect(h.logs.join('\n')).toContain('primary source');
  });
});

describe('configuration failures', () => {
  it('artifact and cache commands fail without their data-plane roots', async () => {
    const h = harness('build');
    const noStores: DataPlaneDeps = { ...h.deps, outStore: undefined, cacheStore: undefined };
    write(h.workdir, 'dist/a', 'x');
    expect(await run(noStores, ['artifact', 'upload', '--name', 'dist', '--path', 'dist'])).toBe(1);
    expect(await run(noStores, ['cache', 'restore', '--key', 'k', '--path', 'x'])).toBe(1);
    expect(h.logs.join('\n')).toContain('MILLWRIGHT_OUT_URI');
    expect(h.logs.join('\n')).toContain('MILLWRIGHT_CACHE_URI');
  });

  it('artifact upload fails without a job identity', async () => {
    const h = harness('build');
    write(h.workdir, 'dist/a', 'x');
    expect(
      await run({ ...h.deps, jobName: undefined }, ['artifact', 'upload', '--name', 'dist', '--path', 'dist']),
    ).toBe(1);
    expect(h.logs.join('\n')).toContain('MILLWRIGHT_JOB');
  });
});
