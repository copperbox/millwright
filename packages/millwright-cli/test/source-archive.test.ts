import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createGitRunner, createSourceArchive } from '../src/local/source-archive';

const tmpdirs: string[] = [];

function tmp(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'millwright-source-'));
  tmpdirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of tmpdirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd, env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null' } })
    .toString()
    .trim();
}

/** A committed fixture repo with one ignored file. */
function fixtureRepo(): string {
  const root = tmp();
  git(root, 'init', '-q');
  git(root, 'config', 'user.email', 'test@example.invalid');
  git(root, 'config', 'user.name', 'test');
  fs.writeFileSync(path.join(root, 'committed.txt'), 'committed\n');
  fs.writeFileSync(path.join(root, '.gitignore'), 'ignored.txt\n');
  fs.mkdirSync(path.join(root, 'bin'));
  fs.writeFileSync(path.join(root, 'bin', 'tool.sh'), '#!/bin/sh\n');
  fs.chmodSync(path.join(root, 'bin', 'tool.sh'), 0o755);
  git(root, 'add', '-A');
  git(root, 'commit', '-qm', 'init');
  fs.writeFileSync(path.join(root, 'ignored.txt'), 'never packed\n');
  return root;
}

/** Extract with the system tar — the arbiter of archive well-formedness. */
function extract(archive: string): string {
  const dir = tmp();
  execFileSync('tar', ['-xzf', archive, '-C', dir]);
  return dir;
}

describe('createSourceArchive', () => {
  it('packs the working tree git-aware: dirty and untracked files in, ignored files out', async () => {
    const root = fixtureRepo();
    fs.writeFileSync(path.join(root, 'committed.txt'), 'dirty edit\n');
    fs.writeFileSync(path.join(root, 'untracked.txt'), 'new\n');
    const outFile = path.join(tmp(), 'source.tar.gz');

    const result = await createSourceArchive(createGitRunner(), { root, clean: false, outFile });

    const extracted = extract(outFile);
    expect(fs.readFileSync(path.join(extracted, 'committed.txt'), 'utf8')).toBe('dirty edit\n');
    expect(fs.readFileSync(path.join(extracted, 'untracked.txt'), 'utf8')).toBe('new\n');
    expect(fs.existsSync(path.join(extracted, 'ignored.txt'))).toBe(false);
    // Executable bits survive the round trip.
    expect(fs.statSync(path.join(extracted, 'bin', 'tool.sh')).mode & 0o111).not.toBe(0);
    expect(result.fileCount).toBe(4);
  });

  it('packs deep paths beyond the 100-byte ustar name field', async () => {
    const root = fixtureRepo();
    const deep = path.join('a'.repeat(60), 'b'.repeat(60));
    fs.mkdirSync(path.join(root, deep), { recursive: true });
    fs.writeFileSync(path.join(root, deep, 'file.txt'), 'deep\n');
    const outFile = path.join(tmp(), 'source.tar.gz');

    await createSourceArchive(createGitRunner(), { root, clean: false, outFile });

    const extracted = extract(outFile);
    expect(fs.readFileSync(path.join(extracted, deep, 'file.txt'), 'utf8')).toBe('deep\n');
  });

  it('--clean archives HEAD, not the working tree', async () => {
    const root = fixtureRepo();
    fs.writeFileSync(path.join(root, 'committed.txt'), 'dirty edit\n');
    fs.writeFileSync(path.join(root, 'untracked.txt'), 'new\n');
    const outFile = path.join(tmp(), 'source.tar.gz');

    await createSourceArchive(createGitRunner(), { root, clean: true, outFile });

    const extracted = extract(outFile);
    expect(fs.readFileSync(path.join(extracted, 'committed.txt'), 'utf8')).toBe('committed\n');
    expect(fs.existsSync(path.join(extracted, 'untracked.txt'))).toBe(false);
  });

  it('skips files deleted from disk but still listed by git', async () => {
    const root = fixtureRepo();
    fs.rmSync(path.join(root, 'committed.txt'));
    const outFile = path.join(tmp(), 'source.tar.gz');

    await createSourceArchive(createGitRunner(), { root, clean: false, outFile });

    const extracted = extract(outFile);
    expect(fs.existsSync(path.join(extracted, 'committed.txt'))).toBe(false);
    expect(fs.existsSync(path.join(extracted, '.gitignore'))).toBe(true);
  });
});
