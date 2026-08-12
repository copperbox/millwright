/**
 * The per-repo last-seen ref→sha map (spec §6.1, §9.4): what a tick's ls-refs
 * answer is diffed against, and what gets committed after the diff's events
 * are emitted. Compression is required v1 behavior — the raw map is ~65 B/ref
 * and the DynamoDB 400 KB item cap is a certainty on large-ref repos.
 */

import { gunzipSync, gzipSync } from 'node:zlib';
import { AdvertisedRef } from './git/ls-refs';

/** Full ref name → the ref's own 40-hex object id (tag objects unpeeled). */
export type RefMap = Readonly<Record<string, string>>;

export const BRANCH_REF_PREFIX = 'refs/heads/';
export const TAG_REF_PREFIX = 'refs/tags/';

/**
 * Safety margin under DynamoDB's 400 KB item cap: the compressed map shares
 * the item with its key and bookkeeping attributes.
 */
export const MAX_COMPRESSED_MAP_BYTES = 380 * 1024;

export class RefMapTooLargeError extends Error {}

/** gzip'd JSON, stored as a DynamoDB binary attribute. */
export function encodeRefMap(map: RefMap): Uint8Array {
  // Sorted keys make encoding deterministic, so an unchanged map re-encodes
  // byte-identical tick over tick.
  const sorted: Record<string, string> = {};
  for (const ref of Object.keys(map).sort()) {
    sorted[ref] = map[ref];
  }
  const compressed = gzipSync(JSON.stringify(sorted));
  if (compressed.length > MAX_COMPRESSED_MAP_BYTES) {
    throw new RefMapTooLargeError(
      `compressed ref map is ${compressed.length} bytes — over the ${MAX_COMPRESSED_MAP_BYTES} ` +
        'byte budget inside the DynamoDB 400 KB item cap',
    );
  }
  return compressed;
}

export function decodeRefMap(encoded: Uint8Array): RefMap {
  return JSON.parse(gunzipSync(encoded).toString('utf8')) as RefMap;
}

export interface ObservedRefs {
  /** The watched namespaces (`refs/heads/*`, `refs/tags/*`) only. */
  readonly map: RefMap;
  /**
   * Peeled commit ids for annotated tags, keyed by ref name — carried on tag
   * events instead of the tag object id, never stored in the map.
   */
  readonly peeled: Readonly<Record<string, string>>;
  /** Short default-branch name from HEAD's symref, when advertised. */
  readonly defaultBranch?: string;
}

/**
 * Fold an ls-refs answer (either protocol version) into the observed map.
 * HEAD itself is never stored — its symref answers default-branch discovery
 * (spec §6.1: zero extra calls) and its oid is already `refs/heads/<default>`.
 */
export function observeRefs(refs: readonly AdvertisedRef[]): ObservedRefs {
  const map: Record<string, string> = {};
  const peeled: Record<string, string> = {};
  let defaultBranch: string | undefined;
  for (const ref of refs) {
    if (ref.name === 'HEAD') {
      if (ref.symrefTarget?.startsWith(BRANCH_REF_PREFIX)) {
        defaultBranch = ref.symrefTarget.slice(BRANCH_REF_PREFIX.length);
      }
      continue;
    }
    if (!ref.sha) {
      continue;
    }
    if (ref.name.startsWith(BRANCH_REF_PREFIX) || ref.name.startsWith(TAG_REF_PREFIX)) {
      map[ref.name] = ref.sha.toLowerCase();
      if (ref.peeled) {
        peeled[ref.name] = ref.peeled.toLowerCase();
      }
    }
  }
  return { map, peeled, ...(defaultBranch ? { defaultBranch } : {}) };
}

export type RefEventKind = 'push' | 'branch' | 'tag';

export interface RefEvent {
  readonly kind: RefEventKind;
  /** Full ref name. */
  readonly ref: string;
  /** Commit id — peeled for annotated tags, so downstream always sees commits. */
  readonly sha: string;
}

/**
 * Diff the observed refs against the last-seen map (spec §6.1):
 *
 * - new `refs/heads/*`                 → `branch`
 * - moved `refs/heads/*`               → `push`
 * - new or moved `refs/tags/*`         → `tag`
 * - deleted refs                       → no event kind exists; they simply
 *                                        leave the committed map
 *
 * Deterministic order (branches before tags, each sorted) so a crash-window
 * re-emit produces the identical batch for the launcher's dedupe.
 */
export function diffRefMaps(previous: RefMap, observed: ObservedRefs): RefEvent[] {
  const events: RefEvent[] = [];
  // Sorted ref names put refs/heads/* ahead of refs/tags/*, so a release's
  // push lands before its tag — and a crash-window re-emit is byte-identical.
  for (const ref of Object.keys(observed.map).sort()) {
    const sha = observed.map[ref];
    const before = previous[ref];
    if (before === sha) {
      continue;
    }
    if (ref.startsWith(BRANCH_REF_PREFIX)) {
      events.push({ kind: before === undefined ? 'branch' : 'push', ref, sha });
    } else {
      events.push({ kind: 'tag', ref, sha: observed.peeled[ref] ?? sha });
    }
  }
  return events;
}
