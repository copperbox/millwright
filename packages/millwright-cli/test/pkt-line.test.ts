import { describe, expect, it } from 'vitest';
import {
  DELIM_PKT,
  FLUSH_PKT,
  Packet,
  PktLineParseError,
  createPktLineFeeder,
  pktLine,
} from '../src/git/pkt-line';

function collect(): { packets: Packet[]; feed: (chunk: Buffer) => void } {
  const packets: Packet[] = [];
  const feed = createPktLineFeeder((p) => packets.push(p));
  return { packets, feed };
}

describe('pktLine', () => {
  it('computes the length prefix as payload+4, hex, zero-padded', () => {
    // The spike lost time to hand-miscounted lengths; this pins the arithmetic.
    expect(pktLine('command=ls-refs\n').toString()).toBe('0014command=ls-refs\n');
    expect(pktLine('peel\n').toString()).toBe('0009peel\n');
    expect(pktLine('a').toString()).toBe('0005a');
  });

  it('exports the special packets', () => {
    expect(FLUSH_PKT.toString()).toBe('0000');
    expect(DELIM_PKT.toString()).toBe('0001');
  });

  it('rejects payloads that cannot fit the 4-hex-digit length', () => {
    expect(() => pktLine('x'.repeat(65517))).toThrow(PktLineParseError);
  });
});

describe('createPktLineFeeder', () => {
  it('parses lines, flush, delim and response-end packets', () => {
    const { packets, feed } = collect();
    feed(Buffer.concat([pktLine('version 2\n'), DELIM_PKT, pktLine('peel\n'), FLUSH_PKT]));
    feed(Buffer.from('0002'));
    expect(packets).toEqual([
      { type: 'line', text: 'version 2' },
      { type: 'delim' },
      { type: 'line', text: 'peel' },
      { type: 'flush' },
      { type: 'response-end' },
    ]);
  });

  it('reassembles packets split across arbitrary chunk boundaries', () => {
    const wire = Buffer.concat([pktLine('0123456789abcdef0123 refs/heads/main\n'), FLUSH_PKT]);
    for (let split = 1; split < wire.length; split++) {
      const { packets, feed } = collect();
      feed(wire.subarray(0, split));
      feed(wire.subarray(split));
      expect(packets).toEqual([
        { type: 'line', text: '0123456789abcdef0123 refs/heads/main' },
        { type: 'flush' },
      ]);
    }
  });

  it('strips exactly one trailing newline from line payloads', () => {
    const { packets, feed } = collect();
    feed(pktLine('no-newline'));
    expect(packets).toEqual([{ type: 'line', text: 'no-newline' }]);
  });

  it('survives re-entrant feeding from inside onPacket', () => {
    // ls-refs replies to the capability flush from inside the packet
    // callback; the response bytes re-enter the feeder synchronously. The
    // flush being delivered must already be consumed by then.
    const packets: Packet[] = [];
    const feed = createPktLineFeeder((p) => {
      packets.push(p);
      if (p.type === 'flush' && packets.length === 1) {
        feed(Buffer.concat([pktLine('reply\n'), FLUSH_PKT]));
      }
    });
    feed(Buffer.concat([FLUSH_PKT, pktLine('after\n')]));
    // FIFO on arrival: the already-buffered 'after' precedes the re-entrant
    // 'reply', the delivered flush is never re-processed, nothing is lost.
    expect(packets).toEqual([
      { type: 'flush' },
      { type: 'line', text: 'after' },
      { type: 'line', text: 'reply' },
      { type: 'flush' },
    ]);
  });

  it('throws on a non-hex length prefix', () => {
    const { feed } = collect();
    expect(() => feed(Buffer.from('zzzzoops'))).toThrow(PktLineParseError);
  });
});
