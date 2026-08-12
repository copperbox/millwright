import { describe, expect, it } from 'vitest';
import {
  KeyFormatError,
  RunCoordinates,
  artifactPrefix,
  cacheObjectKey,
  cachePrefix,
  jobOutputPrefix,
  modelObjectKey,
  runInputPrefix,
  runOutputPrefix,
  runPrefix,
  sourceObjectKey,
} from '../src';

const RUN: RunCoordinates = { repo: 'copperbox/millwright', workflow: 'ci', runNumber: 142 };

describe('S3 layout', () => {
  it('builds the spec §9.3 tree', () => {
    expect(runPrefix(RUN)).toBe('runs/copperbox/millwright/ci/142/');
    expect(runInputPrefix(RUN)).toBe('runs/copperbox/millwright/ci/142/in/');
    expect(modelObjectKey(RUN)).toBe('runs/copperbox/millwright/ci/142/in/model.json');
    expect(sourceObjectKey(RUN)).toBe('runs/copperbox/millwright/ci/142/in/source.tar.gz');
    expect(runOutputPrefix(RUN)).toBe('runs/copperbox/millwright/ci/142/out/');
    expect(jobOutputPrefix(RUN, 'build')).toBe('runs/copperbox/millwright/ci/142/out/build/');
    expect(artifactPrefix(RUN, 'build', 'dist')).toBe(
      'runs/copperbox/millwright/ci/142/out/build/dist/',
    );
    expect(cachePrefix('copperbox/millwright')).toBe('cache/copperbox/millwright/');
    expect(cacheObjectKey('copperbox/millwright', 'node-abc123')).toBe(
      'cache/copperbox/millwright/node-abc123',
    );
  });

  it('confines a job to its own out/<job>/ subtree by construction', () => {
    const mine = jobOutputPrefix(RUN, 'build');
    const sibling = jobOutputPrefix(RUN, 'integration');
    expect(sibling.startsWith(mine)).toBe(false);
    expect(mine.startsWith(runOutputPrefix(RUN))).toBe(true);
  });

  it('rejects traversal and malformed parts', () => {
    expect(() => runPrefix({ ...RUN, repo: 'no-owner' })).toThrow(KeyFormatError);
    expect(() => runPrefix({ ...RUN, runNumber: 0 })).toThrow(KeyFormatError);
    expect(() => jobOutputPrefix(RUN, 'a/b')).toThrow(KeyFormatError);
    expect(() => jobOutputPrefix(RUN, '..')).toThrow(KeyFormatError);
    expect(() => cacheObjectKey('copperbox/millwright', '../escape')).toThrow(KeyFormatError);
  });
});
