import { describe, expect, it } from 'vitest';
import {
  EventIdentity,
  KeyFormatError,
  MAX_RUN_NUMBER,
  RunCoordinates,
  buildMappingKey,
  checkStateKey,
  concurrencyGroupKey,
  eventDedupeKey,
  formatRunId,
  invertedRunNumber,
  jobKey,
  parseBuildMappingKey,
  parseCheckStateKey,
  parseConcurrencyGroupKey,
  parseEventDedupeKey,
  parseInvertedRunNumber,
  parseJobKey,
  parseRegistryKey,
  parseRunCounterKey,
  parseRunId,
  parseRunKey,
  parseStepKey,
  registryKey,
  runCounterKey,
  runKey,
  stepKey,
  stepSortKeyPrefix,
} from '../src';

const REPO = 'copperbox/millwright';
const RUN: RunCoordinates = { repo: REPO, workflow: 'ci', runNumber: 142 };
const SHA = '0123456789abcdef0123456789abcdef01234567';

describe('inverted run numbers', () => {
  it('round-trips', () => {
    for (const n of [1, 2, 9, 10, 142, 99_999, MAX_RUN_NUMBER]) {
      expect(parseInvertedRunNumber(invertedRunNumber(n))).toBe(n);
    }
  });

  it('sorts ascending-lexicographic as descending run number (newest first)', () => {
    const numbers = [1, 2, 9, 10, 11, 99, 100, 101, 12345, 999_999_999];
    const sortKeys = numbers.map((n) => runKey({ ...RUN, runNumber: n }).sk);
    const lexicographic = [...sortKeys].sort();
    const newestFirst = [...numbers].sort((a, b) => b - a);
    expect(lexicographic).toEqual(newestFirst.map((n) => runKey({ ...RUN, runNumber: n }).sk));
  });

  it('rejects zero, negatives, floats and overflow', () => {
    for (const bad of [0, -1, 1.5, MAX_RUN_NUMBER + 1, NaN]) {
      expect(() => invertedRunNumber(bad)).toThrow(KeyFormatError);
    }
    expect(() => parseInvertedRunNumber('123')).toThrow(KeyFormatError);
    expect(() => parseInvertedRunNumber('99999999999x')).toThrow(KeyFormatError);
  });
});

describe('run counter key', () => {
  it('round-trips', () => {
    const key = runCounterKey(REPO, 'ci');
    expect(key).toEqual({ pk: 'WF#copperbox/millwright#ci', sk: 'COUNTER' });
    expect(parseRunCounterKey(key)).toEqual({ repo: REPO, workflow: 'ci' });
  });

  it('rejects "#" in repo or workflow', () => {
    expect(() => runCounterKey('a#b', 'ci')).toThrow(KeyFormatError);
    expect(() => runCounterKey(REPO, 'c#i')).toThrow(KeyFormatError);
  });
});

describe('run key', () => {
  it('round-trips with the inverted zero-padded sort key', () => {
    const key = runKey(RUN);
    expect(key).toEqual({ pk: 'WF#copperbox/millwright#ci', sk: 'RUN#999999999857' });
    expect(parseRunKey(key)).toEqual(RUN);
  });

  it('shares the counter partition so counter and runs colocate', () => {
    expect(runKey(RUN).pk).toBe(runCounterKey(REPO, 'ci').pk);
  });

  it('rejects non-run keys', () => {
    expect(() => parseRunKey({ pk: 'WF#a#b', sk: 'COUNTER' })).toThrow(KeyFormatError);
    expect(() => parseRunKey({ pk: 'RUN#a#b#1', sk: 'RUN#000000000001' })).toThrow(KeyFormatError);
  });
});

describe('job key', () => {
  it('round-trips', () => {
    const key = jobKey(RUN, 'build');
    expect(key).toEqual({ pk: 'RUN#copperbox/millwright#ci#142', sk: 'JOB#build' });
    expect(parseJobKey(key)).toEqual({ ...RUN, job: 'build' });
  });

  it('rejects step keys and malformed partitions', () => {
    expect(() => parseJobKey(stepKey(RUN, 'build', 0))).toThrow(KeyFormatError);
    expect(() => parseJobKey({ pk: 'RUN#a#b#x', sk: 'JOB#build' })).toThrow(KeyFormatError);
  });
});

describe('step key', () => {
  it('round-trips with a zero-padded index', () => {
    const key = stepKey(RUN, 'build', 7);
    expect(key).toEqual({ pk: 'RUN#copperbox/millwright#ci#142', sk: 'JOB#build#STEP#0007' });
    expect(parseStepKey(key)).toEqual({ ...RUN, job: 'build', stepIndex: 7 });
  });

  it('keeps steps in numeric order under lexicographic sort', () => {
    const indexes = [0, 1, 2, 9, 10, 11, 99, 100];
    const sorted = indexes.map((i) => stepKey(RUN, 'build', i).sk).sort();
    expect(sorted).toEqual(indexes.map((i) => stepKey(RUN, 'build', i).sk));
  });

  it('sorts under the per-job prefix', () => {
    expect(stepKey(RUN, 'build', 3).sk.startsWith(stepSortKeyPrefix('build'))).toBe(true);
  });

  it('rejects negative, fractional and oversized indexes', () => {
    for (const bad of [-1, 1.5, 10_000]) {
      expect(() => stepKey(RUN, 'build', bad)).toThrow(KeyFormatError);
    }
  });
});

describe('event dedupe key', () => {
  const event: EventIdentity = { repo: REPO, ref: 'main', sha: SHA, kind: 'push' };

  it('round-trips', () => {
    const key = eventDedupeKey(event);
    expect(key).toEqual({
      pk: `EVENT#copperbox/millwright#main#${SHA}#push`,
      sk: '-',
    });
    expect(parseEventDedupeKey(key)).toEqual(event);
  });

  it('round-trips refs containing "#" and "/"', () => {
    for (const ref of ['release/1.2', 'feature/#42-hopper', 'refs/pull/17', 'a#b#c']) {
      const key = eventDedupeKey({ ...event, ref, kind: 'pr' });
      expect(parseEventDedupeKey(key)).toEqual({ ...event, ref, kind: 'pr' });
    }
  });

  it('rejects unknown kinds and non-hex shas', () => {
    expect(() => eventDedupeKey({ ...event, kind: 'poke' as never })).toThrow(KeyFormatError);
    expect(() => eventDedupeKey({ ...event, sha: 'not-a-sha' })).toThrow(KeyFormatError);
    expect(() =>
      parseEventDedupeKey({ pk: 'EVENT#r/r#main#deadbeef#poke', sk: '-' }),
    ).toThrow(KeyFormatError);
  });

  it('round-trips a cron identity with its minute qualifier', () => {
    const cron: EventIdentity = {
      ...event,
      kind: 'cron',
      qualifier: '2026-08-12T06:03',
    };
    const key = eventDedupeKey(cron);
    expect(key.pk).toBe(`EVENT#copperbox/millwright#main#${SHA}#cron#2026-08-12T06:03`);
    expect(parseEventDedupeKey(key)).toEqual(cron);
  });

  it('distinguishes qualified identities from unqualified ones', () => {
    const a = eventDedupeKey({ ...event, kind: 'cron', qualifier: '2026-08-12T06:03' });
    const b = eventDedupeKey({ ...event, kind: 'cron', qualifier: '2026-08-12T06:04' });
    const c = eventDedupeKey({ ...event, kind: 'cron' });
    expect(new Set([a.pk, b.pk, c.pk]).size).toBe(3);
  });

  it('rejects a qualifier containing "#"', () => {
    expect(() => eventDedupeKey({ ...event, qualifier: 'a#b' })).toThrow(KeyFormatError);
  });
});

describe('run id', () => {
  it('round-trips', () => {
    const coords = { repo: REPO, workflow: 'ci', runNumber: 142 };
    expect(formatRunId(coords)).toBe('copperbox/millwright#ci#142');
    expect(parseRunId('copperbox/millwright#ci#142')).toEqual(coords);
  });

  it('rejects malformed ids', () => {
    for (const bad of ['', 'ci#142', 'a#b#c#1', 'repo#wf#zero', 'repo#wf#0']) {
      expect(() => parseRunId(bad)).toThrow(KeyFormatError);
    }
  });
});

describe('build mapping key', () => {
  it('round-trips a CodeBuild id with ":"', () => {
    const buildId = 'millwright-builds:2c1a7e9b-5555-4c2e-9f57-0a1b2c3d4e5f';
    const key = buildMappingKey(buildId);
    expect(key).toEqual({ pk: `BUILD#${buildId}`, sk: '-' });
    expect(parseBuildMappingKey(key)).toEqual({ buildId });
  });
});

describe('concurrency group key', () => {
  it('round-trips group keys containing token-expanded "#" and "/"', () => {
    for (const group of ['deploy', 'deploy#refs/heads/main', 'ci#copperbox/millwright']) {
      const key = concurrencyGroupKey(group);
      expect(key.pk).toBe(`GROUP#${group}`);
      expect(parseConcurrencyGroupKey(key)).toEqual({ group });
    }
  });
});

describe('registry key', () => {
  it('round-trips, with refs free to contain "#"', () => {
    for (const ref of ['main', 'release/1.2', 'issue#15']) {
      const key = registryKey(REPO, ref);
      expect(key).toEqual({ pk: 'REG#copperbox/millwright', sk: `REF#${ref}` });
      expect(parseRegistryKey(key)).toEqual({ repo: REPO, ref });
    }
  });

  it('rejects foreign keys', () => {
    expect(() => parseRegistryKey({ pk: 'WF#a#b', sk: 'REF#main' })).toThrow(KeyFormatError);
    expect(() => parseRegistryKey({ pk: 'REG#a/b', sk: 'CTX#x' })).toThrow(KeyFormatError);
  });
});

describe('check state key', () => {
  it('round-trips, contexts free to contain spaces and "/"', () => {
    const key = checkStateKey(REPO, SHA, 'ci / build');
    expect(key).toEqual({
      pk: `CHECK#copperbox/millwright#${SHA}`,
      sk: 'CTX#ci / build',
    });
    expect(parseCheckStateKey(key)).toEqual({ repo: REPO, sha: SHA, context: 'ci / build' });
  });

  it('round-trips the reserved synth context', () => {
    const key = checkStateKey(REPO, SHA, 'millwright / synth');
    expect(parseCheckStateKey(key).context).toBe('millwright / synth');
  });
});

describe('cross-shape safety', () => {
  it('every builder yields a distinct pk prefix per shape', () => {
    const prefixes = [
      runCounterKey(REPO, 'ci').pk,
      jobKey(RUN, 'build').pk,
      eventDedupeKey({ repo: REPO, ref: 'main', sha: SHA, kind: 'push' }).pk,
      buildMappingKey('b:1').pk,
      concurrencyGroupKey('g').pk,
      registryKey(REPO, 'main').pk,
      checkStateKey(REPO, SHA, 'ci / build').pk,
    ].map((pk) => pk.split('#')[0]);
    expect(new Set(prefixes).size).toBe(prefixes.length);
  });
});
