import { gunzipSync, gzipSync } from 'node:zlib';

/**
 * Minimal tar.gz support for the shim's data plane (spec §11.2): the job
 * image's contract is "Linux + POSIX shell, nothing more" — no tar binary is
 * assumed — so archives are read and written here, in the shim itself.
 *
 * Reader coverage is what the shim actually meets: ustar archives from GNU
 * and BSD `tar` (the synth job packages `source.tar.gz` with `tar -czf`) —
 * plain files, directories, symlinks, GNU long names ('L'/'K') and pax
 * extended headers ('x' path/linkpath overrides, 'g' skipped). The writer
 * emits plain ustar with deterministic metadata (mtime 0), which is what
 * makes byte-identical cache saves possible for identical content.
 */

const BLOCK = 512;

export class TarError extends Error {}

export interface TarEntry {
  /** `/`-separated relative path inside the archive. */
  readonly path: string;
  readonly type: 'file' | 'dir' | 'symlink';
  /** File content; empty for dirs and symlinks. */
  readonly content: Buffer;
  /** Symlink target, verbatim. */
  readonly linkTarget?: string;
  readonly executable?: boolean;
}

function parseOctal(field: Buffer): number {
  const text = field.toString('ascii').replace(/\0/g, ' ').trim();
  if (text === '') {
    return 0;
  }
  // GNU base-256 encoding (high bit set) appears only for >8 GiB sizes —
  // far beyond any source or cache archive this system produces.
  if (field[0] & 0x80) {
    throw new TarError('base-256 tar number fields are not supported');
  }
  const value = Number.parseInt(text, 8);
  if (Number.isNaN(value)) {
    throw new TarError(`unparseable tar number field "${text}"`);
  }
  return value;
}

function headerChecksum(header: Buffer): number {
  let sum = 0;
  for (let i = 0; i < BLOCK; i += 1) {
    // The checksum field itself counts as spaces.
    sum += i >= 148 && i < 156 ? 0x20 : header[i];
  }
  return sum;
}

function readString(buffer: Buffer, start: number, length: number): string {
  const slice = buffer.subarray(start, start + length);
  const nul = slice.indexOf(0);
  return slice.toString('utf8', 0, nul === -1 ? length : nul);
}

/**
 * Normalize an archive member path: `tar -C dir .` emits `./`-prefixed
 * names. Returns undefined for the archive-root entry itself.
 */
function normalizeMemberPath(raw: string): string | undefined {
  const segments = raw.split('/').filter((s) => s !== '' && s !== '.');
  if (segments.length === 0) {
    return undefined;
  }
  // Zip-slip: nothing may escape the extraction root.
  if (raw.startsWith('/') || segments.includes('..')) {
    throw new TarError(`archive member "${raw}" escapes the extraction root`);
  }
  return segments.join('/');
}

function parsePaxRecords(content: Buffer): Map<string, string> {
  const records = new Map<string, string>();
  let offset = 0;
  while (offset < content.length) {
    const space = content.indexOf(0x20, offset);
    if (space === -1) {
      break;
    }
    const length = Number.parseInt(content.toString('ascii', offset, space), 10);
    if (!Number.isInteger(length) || length <= 0) {
      break;
    }
    const record = content.toString('utf8', space + 1, offset + length - 1);
    const eq = record.indexOf('=');
    if (eq !== -1) {
      records.set(record.slice(0, eq), record.slice(eq + 1));
    }
    offset += length;
  }
  return records;
}

/** Parse a gzipped tar archive into its entries. */
export function extractTarGz(archive: Buffer): TarEntry[] {
  let tar: Buffer;
  try {
    tar = gunzipSync(archive);
  } catch {
    throw new TarError('archive is not valid gzip data');
  }

  const entries: TarEntry[] = [];
  let offset = 0;
  let longName: string | undefined;
  let longLink: string | undefined;
  let paxOverrides: Map<string, string> | undefined;

  while (offset + BLOCK <= tar.length) {
    const header = tar.subarray(offset, offset + BLOCK);
    if (header.every((byte) => byte === 0)) {
      break;
    }
    if (parseOctal(header.subarray(148, 156)) !== headerChecksum(header)) {
      throw new TarError(`corrupt tar header at offset ${offset}`);
    }

    const size = parseOctal(header.subarray(124, 136));
    const type = String.fromCharCode(header[156] || 0x30);
    const content = tar.subarray(offset + BLOCK, offset + BLOCK + size);
    offset += BLOCK + Math.ceil(size / BLOCK) * BLOCK;

    if (type === 'L') {
      longName = readString(content, 0, content.length);
      continue;
    }
    if (type === 'K') {
      longLink = readString(content, 0, content.length);
      continue;
    }
    if (type === 'x') {
      paxOverrides = parsePaxRecords(content);
      continue;
    }
    if (type === 'g') {
      continue; // pax global header (git archive emits one)
    }

    const prefix = readString(header, 345, 155);
    let name = longName ?? paxOverrides?.get('path') ?? readString(header, 0, 100);
    if (!longName && !paxOverrides?.has('path') && prefix) {
      name = `${prefix}/${name}`;
    }
    const linkTarget = longLink ?? paxOverrides?.get('linkpath') ?? readString(header, 157, 100);
    longName = undefined;
    longLink = undefined;
    paxOverrides = undefined;

    const path = normalizeMemberPath(name);
    if (path === undefined) {
      continue;
    }
    const mode = parseOctal(header.subarray(100, 108));

    if (type === '0' || type === '\0' || type === '7') {
      entries.push({
        path,
        type: 'file',
        content: Buffer.from(content),
        executable: (mode & 0o100) !== 0,
      });
    } else if (type === '5') {
      entries.push({ path, type: 'dir', content: Buffer.alloc(0) });
    } else if (type === '2') {
      entries.push({ path, type: 'symlink', content: Buffer.alloc(0), linkTarget });
    }
    // Anything else (hardlinks, fifos, devices) is skipped: none belong in a
    // source tree or dependency cache, and failing on them would make the
    // shim stricter than the tar that packaged the archive.
  }
  return entries;
}

function writeOctal(header: Buffer, offset: number, length: number, value: number): void {
  header.write(value.toString(8).padStart(length - 1, '0'), offset, 'ascii');
}

/** Checksum field convention: six octal digits, NUL, space. */
function finalizeChecksum(header: Buffer): void {
  header.write('        ', 148, 'ascii');
  const sum = headerChecksum(header);
  header.write(sum.toString(8).padStart(6, '0'), 148, 'ascii');
  header[154] = 0;
  header[155] = 0x20;
}

function headerFor(entry: TarEntry, nameField: string, size: number, typeByte: number): Buffer {
  const header = Buffer.alloc(BLOCK);
  header.write(nameField, 0, 100, 'utf8');
  const mode =
    entry.type === 'dir' || (entry.type === 'file' && entry.executable) ? 0o755 : 0o644;
  writeOctal(header, 100, 8, mode);
  writeOctal(header, 108, 8, 0); // uid
  writeOctal(header, 116, 8, 0); // gid
  writeOctal(header, 124, 12, size);
  writeOctal(header, 136, 12, 0); // mtime: deterministic archives
  header[156] = typeByte;
  if (entry.type === 'symlink' && entry.linkTarget) {
    header.write(entry.linkTarget.slice(0, 100), 157, 100, 'utf8');
  }
  header.write('ustar\0', 257, 'ascii');
  header.write('00', 263, 'ascii');
  finalizeChecksum(header);
  return header;
}

function gnuLongNameBlocks(path: string): Buffer[] {
  const name = Buffer.from(`${path}\0`, 'utf8');
  const header = headerFor(
    { path: '././@LongLink', type: 'file', content: Buffer.alloc(0) },
    '././@LongLink',
    name.length,
    0x4c, // 'L'
  );
  const padded = Buffer.alloc(Math.ceil(name.length / BLOCK) * BLOCK);
  name.copy(padded);
  return [header, padded];
}

/** Build a gzipped ustar archive from entries, deterministically. */
export function packTarGz(entries: readonly TarEntry[]): Buffer {
  const blocks: Buffer[] = [];
  for (const entry of entries) {
    const nameField = entry.type === 'dir' ? `${entry.path}/` : entry.path;
    if (Buffer.byteLength(nameField, 'utf8') > 100) {
      blocks.push(...gnuLongNameBlocks(nameField));
    }
    const size = entry.type === 'file' ? entry.content.length : 0;
    const typeByte = entry.type === 'file' ? 0x30 : entry.type === 'dir' ? 0x35 : 0x32;
    blocks.push(headerFor(entry, nameField.slice(0, 100), size, typeByte));
    if (size > 0) {
      const padded = Buffer.alloc(Math.ceil(size / BLOCK) * BLOCK);
      entry.content.copy(padded);
      blocks.push(padded);
    }
  }
  blocks.push(Buffer.alloc(BLOCK * 2));
  return gzipSync(Buffer.concat(blocks), { level: 6 });
}
