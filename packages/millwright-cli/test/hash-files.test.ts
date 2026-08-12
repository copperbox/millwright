import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { compileGlob, hashFilesInTree } from '../src';

const tmpdirs: string[] = [];

function tree(files: Record<string, string>): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'millwright-hash-'));
  tmpdirs.push(dir);
  for (const [rel, content] of Object.entries(files)) {
    const abs = path.join(dir, rel);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, content);
  }
  return dir;
}

afterEach(() => {
  for (const dir of tmpdirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe('compileGlob', () => {
  const TABLE: Array<[pattern: string, file: string, matches: boolean]> = [
    ['package-lock.json', 'package-lock.json', true],
    ['package-lock.json', 'sub/package-lock.json', false], // no implicit deep match
    ['*.lock', 'yarn.lock', true],
    ['*.lock', 'sub/yarn.lock', false], // * stays within a segment
    ['**/*.lock', 'sub/deep/yarn.lock', true],
    ['**/*.lock', 'yarn.lock', true], // **/ also matches zero segments
    ['packages/*/package.json', 'packages/a/package.json', true],
    ['packages/*/package.json', 'packages/a/b/package.json', false],
    ['packages/**', 'packages/a/b/anything', true],
    ['file?.txt', 'file1.txt', true],
    ['file?.txt', 'file12.txt', false],
    ['a+b.txt', 'a+b.txt', true], // regex metachars are literal
    ['a+b.txt', 'aab.txt', false],
  ];

  it.each(TABLE)('pattern %j vs %j -> %s', (pattern, file, expected) => {
    expect(compileGlob(pattern).test(file)).toBe(expected);
  });
});

describe('hashFilesInTree', () => {
  it('is deterministic for identical content and changes when content changes', () => {
    const a = tree({ 'package-lock.json': 'v1', 'src/index.ts': 'code' });
    const b = tree({ 'package-lock.json': 'v1', 'src/index.ts': 'other' });
    const hashA = hashFilesInTree(a, ['package-lock.json']);
    expect(hashA).toMatch(/^[0-9a-f]{64}$/);
    expect(hashFilesInTree(b, ['package-lock.json'])).toBe(hashA);

    fs.writeFileSync(path.join(b, 'package-lock.json'), 'v2');
    expect(hashFilesInTree(b, ['package-lock.json'])).not.toBe(hashA);
  });

  it('folds every matched file in, so renames change the key', () => {
    const a = tree({ 'a.lock': 'same' });
    const b = tree({ 'b.lock': 'same' });
    expect(hashFilesInTree(a, ['**/*.lock'])).not.toBe(hashFilesInTree(b, ['**/*.lock']));
  });

  it('matches across directories with ** and unions multiple patterns', () => {
    const dir = tree({
      'yarn.lock': 'x',
      'packages/a/yarn.lock': 'y',
      'packages/a/package.json': 'z',
    });
    const both = hashFilesInTree(dir, ['**/*.lock']);
    const withJson = hashFilesInTree(dir, ['**/*.lock', '**/package.json']);
    expect(both).not.toBe(hashFilesInTree(dir, ['yarn.lock']));
    expect(withJson).not.toBe(both);
  });

  it('resolves to the empty string when nothing matches (GHA parity)', () => {
    const dir = tree({ 'README.md': 'hi' });
    expect(hashFilesInTree(dir, ['**/*.lock'])).toBe('');
  });

  it('never hashes .git content', () => {
    const dir = tree({ 'a.lock': 'x' });
    const before = hashFilesInTree(dir, ['**']);
    fs.mkdirSync(path.join(dir, '.git'));
    fs.writeFileSync(path.join(dir, '.git', 'HEAD'), 'ref: main');
    expect(hashFilesInTree(dir, ['**'])).toBe(before);
  });
});
