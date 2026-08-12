import { describe, expect, it } from 'vitest';
import { AdvertisedRef } from '../src/runtime/poller/git/ls-refs';
import {
  MAX_COMPRESSED_MAP_BYTES,
  decodeRefMap,
  diffRefMaps,
  encodeRefMap,
  observeRefs,
} from '../src/runtime/poller/ref-map';

const sha = (seed: number) => seed.toString(16).padStart(40, '0');

describe('observeRefs', () => {
  it('keeps only the watched namespaces and answers default-branch discovery', () => {
    const refs: AdvertisedRef[] = [
      { name: 'HEAD', sha: sha(1), symrefTarget: 'refs/heads/main' },
      { name: 'refs/heads/main', sha: sha(1) },
      { name: 'refs/tags/v1', sha: sha(2), peeled: sha(3) },
      { name: 'refs/pull/7/head', sha: sha(4) },
      { name: 'refs/notes/commits', sha: sha(5) },
    ];
    const observed = observeRefs(refs);
    expect(observed.map).toEqual({
      'refs/heads/main': sha(1),
      'refs/tags/v1': sha(2),
    });
    expect(observed.peeled).toEqual({ 'refs/tags/v1': sha(3) });
    expect(observed.defaultBranch).toBe('main');
  });

  it('handles an empty repository with an unborn HEAD', () => {
    const observed = observeRefs([
      { name: 'HEAD', unborn: true, symrefTarget: 'refs/heads/main' },
    ]);
    expect(observed.map).toEqual({});
    expect(observed.defaultBranch).toBe('main');
  });
});

describe('diffRefMaps', () => {
  const previous = {
    'refs/heads/main': sha(1),
    'refs/heads/old': sha(2),
    'refs/tags/v1': sha(3),
  };

  it('classifies moved branches as push, new branches as branch, tags as tag', () => {
    const observed = observeRefs([
      { name: 'refs/heads/main', sha: sha(10) }, // moved
      { name: 'refs/heads/feature', sha: sha(11) }, // new
      { name: 'refs/heads/old', sha: sha(2) }, // unchanged
      { name: 'refs/tags/v1', sha: sha(3) }, // unchanged
      { name: 'refs/tags/v2', sha: sha(12), peeled: sha(13) }, // new annotated
    ]);
    expect(diffRefMaps(previous, observed)).toEqual([
      { kind: 'branch', ref: 'refs/heads/feature', sha: sha(11) },
      { kind: 'push', ref: 'refs/heads/main', sha: sha(10) },
      { kind: 'tag', ref: 'refs/tags/v2', sha: sha(13) },
    ]);
  });

  it('carries the peeled commit on annotated tags, the tag oid otherwise', () => {
    const annotated = observeRefs([{ name: 'refs/tags/v2', sha: sha(20), peeled: sha(21) }]);
    expect(diffRefMaps({}, annotated)[0].sha).toBe(sha(21));
    const lightweight = observeRefs([{ name: 'refs/tags/v3', sha: sha(22) }]);
    expect(diffRefMaps({}, lightweight)[0].sha).toBe(sha(22));
  });

  it('emits nothing for deletions or an unchanged map', () => {
    expect(diffRefMaps(previous, observeRefs([{ name: 'refs/heads/main', sha: sha(1) }]))).toEqual(
      [],
    );
  });

  it('is deterministic, so a crash-window re-emit reproduces the same batch', () => {
    const observed = observeRefs([
      { name: 'refs/tags/v9', sha: sha(31) },
      { name: 'refs/heads/zzz', sha: sha(30) },
    ]);
    const first = diffRefMaps(previous, observed);
    const second = diffRefMaps(previous, observed);
    expect(first).toEqual(second);
    expect(first.map((e) => e.kind)).toEqual(['branch', 'tag']);
  });
});

describe('ref-map compression (spec §6.1: required v1 behavior)', () => {
  it('round-trips a repo with more than 5,000 refs well under the item cap', () => {
    const map: Record<string, string> = {};
    for (let i = 0; i < 5500; i += 1) {
      // Realistic mixed namespace with high-entropy shas.
      const name =
        i % 3 === 0 ? `refs/tags/v${i}.${(i * 7) % 10}.${i % 10}` : `refs/heads/feature/branch-${i}`;
      map[name] = Array.from({ length: 40 }, (_, c) =>
        (((i + 1) * 2654435761 + c * 40503) % 16).toString(16),
      ).join('');
    }
    const encoded = encodeRefMap(map);
    expect(encoded.length).toBeLessThan(MAX_COMPRESSED_MAP_BYTES);
    // The uncompressed JSON is itself around the cap — compression is load-bearing.
    expect(JSON.stringify(map).length).toBeGreaterThan(300 * 1024);
    expect(decodeRefMap(encoded)).toEqual(map);
  });

  it('encodes deterministically regardless of key order', () => {
    const a = encodeRefMap({ 'refs/heads/a': sha(1), 'refs/heads/b': sha(2) });
    const b = encodeRefMap({ 'refs/heads/b': sha(2), 'refs/heads/a': sha(1) });
    expect(Buffer.from(a).equals(Buffer.from(b))).toBe(true);
  });
});
