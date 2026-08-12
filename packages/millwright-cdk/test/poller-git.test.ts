import { EventEmitter } from 'node:events';
import { describe, expect, it } from 'vitest';
import {
  FLUSH_PKT,
  PktLineParseError,
  createPktLineFeeder,
  pktLine,
} from '../src/runtime/poller/git/pkt-line';
import {
  GitProtocolError,
  UploadPackRefusedError,
  UploadPackStream,
  lsRefs,
} from '../src/runtime/poller/git/ls-refs';

const SHA = 'a'.repeat(40);
const OTHER = 'b'.repeat(40);
const PEELED = 'c'.repeat(40);

const V2_AD = Buffer.concat([
  pktLine('version 2\n'),
  pktLine('agent=git/github-g1234\n'),
  pktLine('ls-refs=unborn\n'),
  pktLine('fetch=shallow wait-for-done filter\n'),
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

describe('pkt-line framing', () => {
  it('computes the self-counting length prefix', () => {
    expect(pktLine('command=ls-refs\n').subarray(0, 4).toString()).toBe('0014');
  });

  it('reassembles packets across arbitrary chunk fragmentation', () => {
    const wire = Buffer.concat([pktLine(`${SHA} refs/heads/main\n`), FLUSH_PKT]);
    const seen: string[] = [];
    const feed = createPktLineFeeder((packet) =>
      seen.push(packet.type === 'line' ? packet.text : packet.type),
    );
    for (const byte of wire) {
      feed(Buffer.from([byte]));
    }
    expect(seen).toEqual([`${SHA} refs/heads/main`, 'flush']);
  });

  it('rejects a corrupt length prefix', () => {
    const feed = createPktLineFeeder(() => {});
    expect(() => feed(Buffer.from('zzzz'))).toThrow(PktLineParseError);
  });
});

describe('lsRefs over protocol v2', () => {
  it('requests the watched namespaces and parses refs, symrefs and peels', async () => {
    const fake = new FakeUploadPack((chunk, respond) => {
      if (chunk.includes(Buffer.from('command=ls-refs'))) {
        respond(
          Buffer.concat([
            pktLine(`${SHA} HEAD symref-target:refs/heads/main\n`),
            pktLine(`${SHA} refs/heads/main\n`),
            pktLine(`${OTHER} refs/tags/v1 peeled:${PEELED}\n`),
            FLUSH_PKT,
          ]),
        );
      }
    });
    const promise = lsRefs(fake, { refPrefixes: ['HEAD', 'refs/heads/', 'refs/tags/'] });
    fake.respond(V2_AD);
    const result = await promise;

    expect(result.protocolVersion).toBe(2);
    expect(result.refs).toEqual([
      { name: 'HEAD', sha: SHA, symrefTarget: 'refs/heads/main' },
      { name: 'refs/heads/main', sha: SHA },
      { name: 'refs/tags/v1', sha: OTHER, peeled: PEELED },
    ]);
    const request = Buffer.concat(fake.written).toString();
    expect(request).toContain('command=ls-refs\n');
    expect(request).toContain('peel\n');
    expect(request).toContain('symrefs\n');
    expect(request).toContain('ref-prefix HEAD\n');
    expect(request).toContain('ref-prefix refs/heads/\n');
    expect(request).toContain('ref-prefix refs/tags/\n');
  });

  it('parses the protocol-v0 advertisement when the env was refused', async () => {
    const fake = new FakeUploadPack();
    const promise = lsRefs(fake, { refPrefixes: ['HEAD'] });
    fake.respond(
      Buffer.concat([
        pktLine(`${SHA} HEAD\0multi_ack symref=HEAD:refs/heads/trunk agent=git/2\n`),
        pktLine(`${SHA} refs/heads/trunk\n`),
        pktLine(`${OTHER} refs/tags/v1\n`),
        pktLine(`${PEELED} refs/tags/v1^{}\n`),
        FLUSH_PKT,
      ]),
    );
    const result = await promise;

    expect(result.protocolVersion).toBe(0);
    expect(result.refs).toEqual([
      { name: 'HEAD', sha: SHA, symrefTarget: 'refs/heads/trunk' },
      { name: 'refs/heads/trunk', sha: SHA },
      { name: 'refs/tags/v1', sha: OTHER, peeled: PEELED },
    ]);
  });

  it('surfaces a server ERR packet as a refusal, not a protocol error', async () => {
    const fake = new FakeUploadPack();
    const promise = lsRefs(fake, { refPrefixes: ['HEAD'] });
    fake.respond(Buffer.concat([pktLine('ERR Repository not found.\n'), FLUSH_PKT]));
    await expect(promise).rejects.toThrow(UploadPackRefusedError);
    await expect(promise).rejects.toThrow('Repository not found.');
  });

  it('rejects when the channel closes before the response completes', async () => {
    const fake = new FakeUploadPack();
    const promise = lsRefs(fake, { refPrefixes: ['HEAD'] });
    fake.respond(pktLine('version 2\n'));
    fake.emit('close');
    await expect(promise).rejects.toThrow(GitProtocolError);
  });
});
