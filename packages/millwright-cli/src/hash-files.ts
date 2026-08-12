import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';

/**
 * The CLI's `hashFiles(...)` resolver (spec §12): cache keys are resolved at
 * synth, against the checked-out source — both `millwright synth` at a repo
 * root and the synth job over its detached checkout pass through here.
 *
 * Semantics mirror GitHub Actions' `hashFiles`: patterns are workspace-
 * relative globs (`*` and `?` stay within a path segment, `**` crosses
 * segments), the matched set is sorted and each file's content digest folded
 * into one SHA-256, and a pattern set matching nothing resolves to the empty
 * string — which is why synth requires a literal key part alongside.
 */

/** Compile one glob to an anchored regex over `/`-separated relative paths. */
export function compileGlob(pattern: string): RegExp {
  let regex = '';
  let i = 0;
  while (i < pattern.length) {
    const char = pattern[i];
    if (char === '*') {
      if (pattern[i + 1] === '*') {
        // `**/` matches zero or more whole segments; a trailing/lone `**`
        // matches anything, including `/`.
        if (pattern[i + 2] === '/') {
          regex += '(?:[^/]+/)*';
          i += 3;
        } else {
          regex += '.*';
          i += 2;
        }
      } else {
        regex += '[^/]*';
        i += 1;
      }
    } else if (char === '?') {
      regex += '[^/]';
      i += 1;
    } else {
      regex += char.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      i += 1;
    }
  }
  return new RegExp(`^${regex}$`);
}

function walk(rootDir: string, relDir: string, out: string[]): void {
  const absDir = path.join(rootDir, relDir);
  for (const entry of fs.readdirSync(absDir, { withFileTypes: true })) {
    // Jobs never see `.git` (the source archive excludes it, §9.3), so keys
    // must not depend on it either.
    if (entry.name === '.git') {
      continue;
    }
    const rel = relDir ? `${relDir}/${entry.name}` : entry.name;
    if (entry.isDirectory()) {
      walk(rootDir, rel, out);
    } else if (entry.isFile()) {
      out.push(rel);
    }
    // Symlinks and specials are skipped: a key must never hash content
    // outside the tree it claims to describe.
  }
}

/**
 * Hash every file matching any pattern under `rootDir`. Returns a hex
 * SHA-256, or the empty string when nothing matches (GHA parity).
 */
export function hashFilesInTree(rootDir: string, patterns: readonly string[]): string {
  const globs = patterns.map(compileGlob);
  const files: string[] = [];
  walk(rootDir, '', files);
  const matched = files.filter((file) => globs.some((glob) => glob.test(file))).sort();
  if (matched.length === 0) {
    return '';
  }
  const hash = createHash('sha256');
  for (const file of matched) {
    const content = createHash('sha256')
      .update(fs.readFileSync(path.join(rootDir, file)))
      .digest('hex');
    // Path and content are both folded in, NUL-separated, so renames and
    // adjacent-file boundary shifts change the key.
    hash.update(`${file}\0${content}\0`);
  }
  return hash.digest('hex');
}

/** The `resolveHashFiles` synth option, bound to a checkout root. */
export function createHashFilesResolver(rootDir: string): (patterns: readonly string[]) => string {
  return (patterns) => hashFilesInTree(rootDir, patterns);
}
