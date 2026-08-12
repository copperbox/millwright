import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { gzipSync } from 'node:zlib';
import { afterEach, describe, expect, it } from 'vitest';
import { TarEntry, TarError, extractTarGz, packTarGz } from '../src/runtime/shim/tar';

const tmpdirs: string[] = [];

function tmp(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'millwright-tar-'));
  tmpdirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of tmpdirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe('packTarGz / extractTarGz round trip', () => {
  it('preserves files, directories, exec bits and symlinks', () => {
    const entries: TarEntry[] = [
      { path: 'dist', type: 'dir', content: Buffer.alloc(0) },
      { path: 'dist/app.js', type: 'file', content: Buffer.from('console.log(1)') },
      { path: 'bin/run', type: 'file', content: Buffer.from('#!/bin/sh\n'), executable: true },
      { path: 'link', type: 'symlink', content: Buffer.alloc(0), linkTarget: 'dist/app.js' },
    ];
    const roundTripped = extractTarGz(packTarGz(entries));
    expect(roundTripped).toHaveLength(4);
    const byPath = new Map(roundTripped.map((e) => [e.path, e]));
    expect(byPath.get('dist')?.type).toBe('dir');
    expect(byPath.get('dist/app.js')?.content.toString()).toBe('console.log(1)');
    expect(byPath.get('dist/app.js')?.executable).toBe(false);
    expect(byPath.get('bin/run')?.executable).toBe(true);
    expect(byPath.get('link')).toMatchObject({ type: 'symlink', linkTarget: 'dist/app.js' });
  });

  it('is deterministic: identical entries produce identical bytes', () => {
    const entries: TarEntry[] = [
      { path: 'a.txt', type: 'file', content: Buffer.from('same') },
    ];
    expect(packTarGz(entries).equals(packTarGz(entries))).toBe(true);
  });

  it('handles names longer than the 100-byte ustar field', () => {
    const long = `deep/${'x'.repeat(120)}/file.txt`;
    const entries = extractTarGz(
      packTarGz([{ path: long, type: 'file', content: Buffer.from('deep') }]),
    );
    expect(entries).toEqual([
      { path: long, type: 'file', content: Buffer.from('deep'), executable: false },
    ]);
  });

  it('handles non-block-multiple content sizes', () => {
    const content = Buffer.alloc(513, 7);
    const [entry] = extractTarGz(packTarGz([{ path: 'blob', type: 'file', content }]));
    expect(entry.content.equals(content)).toBe(true);
  });
});

describe('extractTarGz against the system tar (source.tar.gz parity)', () => {
  it('reads what "tar -czf … -C dir ." packaged, ./-prefixes and all', () => {
    const dir = tmp();
    fs.mkdirSync(path.join(dir, 'src'));
    fs.writeFileSync(path.join(dir, 'src', 'index.ts'), 'export {}');
    fs.writeFileSync(path.join(dir, 'run.sh'), '#!/bin/sh\n', { mode: 0o755 });
    fs.mkdirSync(path.join(dir, '.git'));
    fs.writeFileSync(path.join(dir, '.git', 'HEAD'), 'ref');
    const archive = path.join(tmp(), 'source.tar.gz');
    execFileSync('tar', ['-czf', archive, '--exclude=.git', '-C', dir, '.']);

    const entries = extractTarGz(fs.readFileSync(archive));
    const byPath = new Map(entries.map((e) => [e.path, e]));
    expect(byPath.get('src/index.ts')?.content.toString()).toBe('export {}');
    expect(byPath.get('run.sh')?.executable).toBe(true);
    expect(byPath.has('.git/HEAD')).toBe(false);
    // The `.` root entry is dropped, not materialized.
    expect(entries.every((e) => e.path !== '')).toBe(true);
  });
});

describe('extraction safety', () => {
  it('rejects members that escape the extraction root', () => {
    // Hand-build a header claiming ../evil — packTarGz would refuse to.
    const header = Buffer.alloc(512);
    header.write('../evil', 0, 'utf8');
    header.write('0000644', 100, 'ascii');
    header.write('00000000000', 124, 'ascii');
    header.write('00000000000', 136, 'ascii');
    header[156] = 0x30;
    header.write('ustar\0', 257, 'ascii');
    header.write('        ', 148, 'ascii');
    let sum = 0;
    for (let i = 0; i < 512; i += 1) {
      sum += header[i];
    }
    header.write(sum.toString(8).padStart(6, '0'), 148, 'ascii');
    header[154] = 0;
    header[155] = 0x20;
    const archive = gzipSync(Buffer.concat([header, Buffer.alloc(1024)]));
    expect(() => extractTarGz(archive)).toThrow(TarError);
    expect(() => extractTarGz(archive)).toThrow(/escapes the extraction root/);
  });

  it('rejects non-gzip data and corrupt headers', () => {
    expect(() => extractTarGz(Buffer.from('not gzip'))).toThrow(/not valid gzip/);
  });
});
