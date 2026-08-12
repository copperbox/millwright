import type { S3Client } from '@aws-sdk/client-s3';
import { describe, expect, it } from 'vitest';
import { S3PrefixCopier } from '../src/runtime/launcher/copier';

interface ListInput {
  Bucket: string;
  Prefix: string;
  ContinuationToken?: string;
}
interface CopyInput {
  Bucket: string;
  Key: string;
  CopySource: string;
}

function fakeS3(pages: { keys: string[]; next?: string }[]): {
  client: S3Client;
  copies: CopyInput[];
  lists: ListInput[];
} {
  const copies: CopyInput[] = [];
  const lists: ListInput[] = [];
  const client = {
    send: async (command: { constructor: { name: string }; input: unknown }) => {
      if (command.constructor.name === 'ListObjectsV2Command') {
        lists.push(command.input as ListInput);
        const page = pages.shift() ?? { keys: [] };
        return {
          Contents: page.keys.map((Key) => ({ Key })),
          NextContinuationToken: page.next,
        };
      }
      copies.push(command.input as CopyInput);
      return {};
    },
  } as unknown as S3Client;
  return { client, copies, lists };
}

describe('S3PrefixCopier', () => {
  it('copies every object to the same relative key under the target prefix', async () => {
    const { client, copies } = fakeS3([
      { keys: ['runs/octo/app/ci/41/out/build/dist/a.js', 'runs/octo/app/ci/41/out/build/dist/b c.js'] },
    ]);
    const copier = new S3PrefixCopier(client, 'bkt');
    const copied = await copier.copyPrefix('runs/octo/app/ci/41/out/build/', 'runs/octo/app/ci/42/out/build/');
    expect(copied).toBe(2);
    expect(copies[0]).toEqual({
      Bucket: 'bkt',
      Key: 'runs/octo/app/ci/42/out/build/dist/a.js',
      CopySource: 'bkt/runs/octo/app/ci/41/out/build/dist/a.js',
    });
    // Object names under out/<job>/ are job-authored: URI-encode per segment.
    expect(copies[1].CopySource).toBe('bkt/runs/octo/app/ci/41/out/build/dist/b%20c.js');
  });

  it('walks continuation tokens across pages', async () => {
    const { client, copies, lists } = fakeS3([
      { keys: ['runs/o/a/ci/1/in/model.json'], next: 'page-2' },
      { keys: ['runs/o/a/ci/1/in/source.tar.gz'] },
    ]);
    const copier = new S3PrefixCopier(client, 'bkt');
    expect(await copier.copyPrefix('runs/o/a/ci/1/in/', 'runs/o/a/ci/2/in/')).toBe(2);
    expect(lists.map((l) => l.ContinuationToken)).toEqual([undefined, 'page-2']);
    expect(copies.map((c) => c.Key)).toEqual([
      'runs/o/a/ci/2/in/model.json',
      'runs/o/a/ci/2/in/source.tar.gz',
    ]);
  });
});
