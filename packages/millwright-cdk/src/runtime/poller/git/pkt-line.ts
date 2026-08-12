/**
 * Git pkt-line framing (protocol v2, gitprotocol-common). Each packet is a
 * 4-hex-digit length prefix counting itself (payload+4), with three special
 * lengths: 0000 flush, 0001 delimiter, 0002 response-end.
 */

export class PktLineParseError extends Error {}

export const FLUSH_PKT = Buffer.from('0000');
export const DELIM_PKT = Buffer.from('0001');

/** Largest payload a pkt-line can carry (65520 total minus the 4-byte prefix). */
const MAX_PAYLOAD = 65516;

/**
 * Frame one payload as a pkt-line. The length prefix counts itself — the
 * ticket-016 spike lost time to hand-miscounted lengths, so it is always
 * computed here.
 */
export function pktLine(payload: string | Buffer): Buffer {
  const body = Buffer.isBuffer(payload) ? payload : Buffer.from(payload, 'utf8');
  if (body.length > MAX_PAYLOAD) {
    throw new PktLineParseError(`pkt-line payload of ${body.length} bytes exceeds ${MAX_PAYLOAD}`);
  }
  const prefix = (body.length + 4).toString(16).padStart(4, '0');
  return Buffer.concat([Buffer.from(prefix, 'ascii'), body]);
}

export type Packet =
  | { readonly type: 'flush' }
  | { readonly type: 'delim' }
  | { readonly type: 'response-end' }
  | { readonly type: 'line'; readonly text: string };

/**
 * Incremental pkt-line parser: feed wire chunks in any fragmentation, packets
 * come out in order. Line payloads are UTF-8 decoded with exactly one
 * trailing newline stripped (the protocol terminates text lines with one).
 */
export function createPktLineFeeder(onPacket: (packet: Packet) => void): (chunk: Buffer) => void {
  let pending: Buffer = Buffer.alloc(0);
  return (chunk: Buffer) => {
    pending = pending.length === 0 ? chunk : Buffer.concat([pending, chunk]);
    while (pending.length >= 4) {
      const prefix = pending.subarray(0, 4).toString('ascii');
      if (!/^[0-9a-f]{4}$/.test(prefix)) {
        throw new PktLineParseError(`invalid pkt-line length prefix "${prefix}"`);
      }
      const length = parseInt(prefix, 16);
      if (length === 3) {
        throw new PktLineParseError('invalid pkt-line length 0003');
      }
      if (length > 3 && pending.length < length) {
        break;
      }
      // Consume BEFORE emitting: onPacket may synchronously write to the
      // peer, whose response re-enters this feeder — the packet being
      // delivered must already be off the buffer by then.
      if (length <= 2) {
        pending = pending.subarray(4);
        onPacket(
          length === 0
            ? { type: 'flush' }
            : length === 1
              ? { type: 'delim' }
              : { type: 'response-end' },
        );
        continue;
      }
      const text = pending.subarray(4, length).toString('utf8').replace(/\n$/, '');
      pending = pending.subarray(length);
      onPacket({ type: 'line', text });
    }
  };
}
