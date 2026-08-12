import { execFile } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as zlib from 'node:zlib';
import { CommandError } from '../config-plane';

/**
 * Source delivery for local runs (spec §14): the same `in/source.tar.gz`
 * shape the cloud run prefix carries, so the shim's `source unpack` phase is
 * identical. Default content is the git-aware WORKING TREE (tracked plus
 * untracked-but-not-ignored files — feedback before commit is the point;
 * .gitignore keeps host node_modules out of the containers); `--clean`
 * archives HEAD instead — bit-for-bit what a cloud run at this commit sees.
 */

export type GitRunner = (args: readonly string[], cwd: string) => Promise<Buffer>;

export function createGitRunner(): GitRunner {
  return (args, cwd) =>
    new Promise((resolve, reject) => {
      execFile(
        'git',
        args as string[],
        { cwd, maxBuffer: 512 * 1024 * 1024, encoding: 'buffer' },
        (error, stdout, stderr) => {
          if (error) {
            reject(new CommandError(`git ${args[0]} failed: ${stderr.toString().trim() || error.message}`));
            return;
          }
          resolve(stdout);
        },
      );
    });
}

const BLOCK = 512;

function tarHeader(name: string, size: number, mode: number, type: '0' | '2', linkName = ''): Buffer {
  const header = Buffer.alloc(BLOCK);
  header.write(name, 0, 100, 'utf8');
  header.write(`${mode.toString(8).padStart(7, '0')}\0`, 100);
  header.write('0000000\0', 108); // uid
  header.write('0000000\0', 116); // gid
  header.write(`${size.toString(8).padStart(11, '0')}\0`, 124);
  header.write('00000000000\0', 136); // mtime: zero for determinism
  header.write('        ', 148); // checksum placeholder
  header.write(type, 156);
  header.write(linkName, 157, 100, 'utf8');
  header.write('ustar\0', 257);
  header.write('00', 263);
  let checksum = 0;
  for (const byte of header) {
    checksum += byte;
  }
  header.write(`${checksum.toString(8).padStart(6, '0')}\0 `, 148);
  return header;
}

/**
 * Pack files (paths relative to `root`, `/`-separated) into a gzipped ustar
 * archive. Long paths (>100 bytes) get a PAX-less `ustar` prefix split;
 * paths that fit neither field are refused rather than silently mangled.
 */
export function packTarGz(root: string, files: readonly string[]): Buffer {
  const chunks: Buffer[] = [];
  for (const file of [...files].sort()) {
    const absolute = path.join(root, ...file.split('/'));
    const stat = fs.lstatSync(absolute);
    if (stat.isSymbolicLink()) {
      const target = fs.readlinkSync(absolute);
      chunks.push(headerFor(file, 0, 0o777, '2', target));
      continue;
    }
    if (!stat.isFile()) {
      continue;
    }
    const mode = stat.mode & 0o111 ? 0o755 : 0o644;
    const body = fs.readFileSync(absolute);
    chunks.push(headerFor(file, body.length, mode, '0'), body);
    const remainder = body.length % BLOCK;
    if (remainder !== 0) {
      chunks.push(Buffer.alloc(BLOCK - remainder));
    }
  }
  chunks.push(Buffer.alloc(BLOCK * 2));
  return zlib.gzipSync(Buffer.concat(chunks));
}

function headerFor(file: string, size: number, mode: number, type: '0' | '2', link = ''): Buffer {
  if (Buffer.byteLength(file, 'utf8') <= 100) {
    return tarHeader(file, size, mode, type, link);
  }
  const cut = file.lastIndexOf('/', 155);
  const prefix = cut > 0 ? file.slice(0, cut) : '';
  const name = file.slice(cut + 1);
  if (!prefix || Buffer.byteLength(prefix) > 155 || Buffer.byteLength(name) > 100) {
    throw new CommandError(`source path too long for the archive: ${file}`);
  }
  const header = tarHeader(name, size, mode, type, link);
  header.write(prefix, 345, 155, 'utf8');
  // Rewrite the checksum over the prefixed header.
  header.write('        ', 148);
  let checksum = 0;
  for (const byte of header) {
    checksum += byte;
  }
  header.write(`${checksum.toString(8).padStart(6, '0')}\0 `, 148);
  return header;
}

export interface SourceArchiveOptions {
  readonly root: string;
  /** `--clean`: archive HEAD instead of the working tree. */
  readonly clean: boolean;
  readonly outFile: string;
}

export interface SourceArchiveResult {
  /** Files packed; undefined for `--clean` (git owns the listing). */
  readonly fileCount?: number;
}

export async function createSourceArchive(
  git: GitRunner,
  options: SourceArchiveOptions,
): Promise<SourceArchiveResult> {
  if (options.clean) {
    const archive = await git(['archive', '--format=tar.gz', 'HEAD'], options.root);
    fs.writeFileSync(options.outFile, archive);
    return {};
  }
  const listing = await git(
    ['ls-files', '-z', '--cached', '--others', '--exclude-standard'],
    options.root,
  );
  const files = listing
    .toString('utf8')
    .split('\0')
    .filter(Boolean)
    // ls-files --cached lists locally-deleted paths too; pack what exists
    // (lstat, so intact symlinks with absent targets still ride along).
    .filter((file) => {
      try {
        fs.lstatSync(path.join(options.root, ...file.split('/')));
        return true;
      } catch {
        return false;
      }
    });
  fs.writeFileSync(options.outFile, packTarGz(options.root, files));
  return { fileCount: files.length };
}
