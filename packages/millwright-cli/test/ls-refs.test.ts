import { EventEmitter } from 'node:events';
import { describe, expect, it } from 'vitest';
import { DELIM_PKT, FLUSH_PKT, pktLine } from '../src/git/pkt-line';
import {
  GitProtocolError,
  lsRefs,
  resolveDefaultBranchHead,
  UploadPackStream,
} from '../src/git/ls-refs';

const SHA = 'a'.repeat(40);
const OTHER = 'b'.repeat(40);

const V2_AD = Buffer.concat([
  pktLine('version 2\n'),
  pktLine('agent=git/github-g1234\n'),
  pktLine('ls-refs=unborn\n'),
  pktLine('fetch=shallow wait-for-done filter\n'),
  pktLine('server-option\n'),
  pktLine('object-format=sha1\n'),
  FLUSH_PKT,
]);

/** Scripted git-upload-pack endpoint: emits `data`, records what the client writes. */
class FakeUploadPack extends EventEmitter implements UploadPackStream {
  readonly written: Buffer[] = [];
  private readonly onWrite?: (chunk: Buffer, respond: (wire: Buffer) => void) => void;

  constructor(onWrite?: (chunk: Buffer, respond: (wire: Buffer) => void) => void) {
    super();
    this.onWrite = onWrite;
  }

  write(chunk: Buffer): void {
    this.written.push(chunk);
    this.onWrite?.(chunk, (wire) => this.emit('data', wire));
  }

  respond(wire: Buffer): void {
    this.emit('data', wire);
  }
}

describe('lsRefs (protocol v2)', () => {
  it('sends a well-formed ls-refs request and parses the ref response', async () => {
    const fake = new FakeUploadPack((chunk, respond) => {
      // Only respond to the command request, not the goodbye flush.
      if (chunk.includes(Buffer.from('command=ls-refs'))) {
        respond(
          Buffer.concat([
            pktLine(`${SHA} HEAD symref-target:refs/heads/main\n`),
            pktLine(`${SHA} refs/heads/main\n`),
            pktLine(`${OTHER} refs/tags/v1 peeled:${SHA}\n`),
            FLUSH_PKT,
          ]),
        );
      }
    });
    const promise = lsRefs(fake, { refPrefixes: ['HEAD', 'refs/heads/'] });
    fake.respond(V2_AD);
    const result = await promise;

    expect(result.protocolVersion).toBe(2);
    expect(result.refs).toEqual([
      { name: 'HEAD', sha: SHA, symrefTarget: 'refs/heads/main' },
      { name: 'refs/heads/main', sha: SHA },
      { name: 'refs/tags/v1', sha: OTHER, peeled: SHA },
    ]);

    const request = Buffer.concat(fake.written).toString();
    expect(request).toContain('0014command=ls-refs\n');
    expect(request).toContain(DELIM_PKT.toString());
    expect(request).toContain('peel\n');
    expect(request).toContain('symrefs\n');
    expect(request).toContain('unborn\n'); // advertised by ls-refs=unborn, so requested
    expect(request).toContain('ref-prefix HEAD\n');
    expect(request).toContain('ref-prefix refs/heads/\n');
  });

  it('reports an unborn HEAD on an empty repository', async () => {
    const fake = new FakeUploadPack((chunk, respond) => {
      if (chunk.includes(Buffer.from('command=ls-refs'))) {
        respond(
          Buffer.concat([pktLine('unborn HEAD symref-target:refs/heads/main\n'), FLUSH_PKT]),
        );
      }
    });
    const promise = lsRefs(fake, { refPrefixes: ['HEAD'] });
    fake.respond(V2_AD);
    const result = await promise;
    expect(result.refs).toEqual([
      { name: 'HEAD', unborn: true, symrefTarget: 'refs/heads/main' },
    ]);
  });

  it('does not request unborn when the server does not advertise it', async () => {
    const ad = Buffer.concat([
      pktLine('version 2\n'),
      pktLine('ls-refs\n'),
      pktLine('object-format=sha1\n'),
      FLUSH_PKT,
    ]);
    const fake = new FakeUploadPack((chunk, respond) => {
      if (chunk.includes(Buffer.from('command=ls-refs'))) {
        respond(FLUSH_PKT);
      }
    });
    const promise = lsRefs(fake, { refPrefixes: ['HEAD'] });
    fake.respond(ad);
    await promise;
    expect(Buffer.concat(fake.written).toString()).not.toContain('unborn');
  });

  it('falls back to parsing the protocol-v0 advertisement when the env was refused', async () => {
    const fake = new FakeUploadPack();
    const promise = lsRefs(fake, { refPrefixes: ['HEAD'] });
    fake.respond(
      Buffer.concat([
        pktLine(`${SHA} HEAD\0multi_ack symref=HEAD:refs/heads/trunk agent=git/2\n`),
        pktLine(`${SHA} refs/heads/trunk\n`),
        pktLine(`${OTHER} refs/tags/v1\n`),
        pktLine(`${SHA} refs/tags/v1^{}\n`),
        FLUSH_PKT,
      ]),
    );
    const result = await promise;
    expect(result.protocolVersion).toBe(0);
    expect(result.refs).toEqual([
      { name: 'HEAD', sha: SHA, symrefTarget: 'refs/heads/trunk' },
      { name: 'refs/heads/trunk', sha: SHA },
      { name: 'refs/tags/v1', sha: OTHER, peeled: SHA },
    ]);
  });

  it('rejects on stream errors', async () => {
    const fake = new FakeUploadPack();
    const promise = lsRefs(fake, { refPrefixes: ['HEAD'] });
    fake.emit('error', new Error('connection reset'));
    await expect(promise).rejects.toThrow('connection reset');
  });

  it('rejects when the stream closes before the response completes', async () => {
    const fake = new FakeUploadPack();
    const promise = lsRefs(fake, { refPrefixes: ['HEAD'] });
    fake.respond(V2_AD);
    fake.emit('close');
    await expect(promise).rejects.toThrow(GitProtocolError);
  });

  it('rejects on an unparseable ref line', async () => {
    const fake = new FakeUploadPack((chunk, respond) => {
      if (chunk.includes(Buffer.from('command=ls-refs'))) {
        respond(Buffer.concat([pktLine('what even is this\n'), FLUSH_PKT]));
      }
    });
    const promise = lsRefs(fake, { refPrefixes: ['HEAD'] });
    fake.respond(V2_AD);
    await expect(promise).rejects.toThrow(GitProtocolError);
  });
});

describe('resolveDefaultBranchHead', () => {
  it('resolves branch and sha from a populated repo', () => {
    expect(
      resolveDefaultBranchHead({
        protocolVersion: 2,
        refs: [{ name: 'HEAD', sha: SHA, symrefTarget: 'refs/heads/main' }],
      }),
    ).toEqual({ branch: 'main', ref: 'refs/heads/main', sha: SHA, empty: false });
  });

  it('reports an empty repo from an unborn HEAD, still naming the default branch', () => {
    expect(
      resolveDefaultBranchHead({
        protocolVersion: 2,
        refs: [{ name: 'HEAD', unborn: true, symrefTarget: 'refs/heads/trunk' }],
      }),
    ).toEqual({ branch: 'trunk', ref: 'refs/heads/trunk', empty: true });
  });

  it('reports an empty repo when nothing was advertised at all', () => {
    expect(resolveDefaultBranchHead({ protocolVersion: 2, refs: [] })).toEqual({ empty: true });
  });
});
