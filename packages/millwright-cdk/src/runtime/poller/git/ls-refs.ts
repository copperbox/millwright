/**
 * Protocol-v2 `ls-refs` over an already-open `git-upload-pack` channel
 * (spec §6.1, proven live by the ticket-016 spike). The driver speaks to any
 * byte stream, so tests script the exchange without SSH; `ssh.ts` provides
 * the real ssh2 channel.
 *
 * Fallback: when the server ignored the GIT_PROTOCOL env, the first packet is
 * the protocol-v0 advertisement rather than `version 2` — fat but correct;
 * parsed anyway, exactly as the spec directs.
 */

import { DELIM_PKT, FLUSH_PKT, createPktLineFeeder, pktLine } from './pkt-line';

export class GitProtocolError extends Error {}

/**
 * The server refused to serve the repository: an `ERR` packet on the
 * upload-pack channel ("Repository not found.", access revoked, …). This is
 * a per-repo condition, never a transport problem — the poller quarantines
 * on it instead of counting it toward the circuit-breaker quorum.
 */
export class UploadPackRefusedError extends Error {}

/** The byte-stream slice of an exec'd upload-pack channel; tests fake this. */
export interface UploadPackStream {
  write(chunk: Buffer): void;
  on(event: 'data', listener: (chunk: Buffer) => void): unknown;
  on(event: 'error', listener: (err: Error) => void): unknown;
  on(event: 'close', listener: () => void): unknown;
}

export interface LsRefsOptions {
  /** `ref-prefix` filters; `HEAD` alone answers default-branch discovery. */
  readonly refPrefixes: readonly string[];
  /** agent capability sent with the request. @default millwright-poller */
  readonly agent?: string;
}

export interface AdvertisedRef {
  readonly name: string;
  /** 40-hex object id; absent only for an unborn HEAD. */
  readonly sha?: string;
  /** Set on HEAD when the server reports its symref target. */
  readonly symrefTarget?: string;
  /** Peeled object id for annotated tags. */
  readonly peeled?: string;
  /** True for the unborn HEAD of an empty repository. */
  readonly unborn?: boolean;
}

export interface LsRefsResult {
  readonly protocolVersion: 0 | 2;
  readonly refs: readonly AdvertisedRef[];
}

const SHA_LINE = /^[0-9a-f]{40} /;

function parseV2RefLine(text: string): AdvertisedRef {
  const parts = text.split(' ');
  if (parts.length < 2 || (parts[0] !== 'unborn' && !/^[0-9a-f]{40}$/.test(parts[0]))) {
    throw new GitProtocolError(`unparseable ls-refs response line: "${text}"`);
  }
  const [oid, name, ...attributes] = parts;
  let symrefTarget: string | undefined;
  let peeled: string | undefined;
  for (const attribute of attributes) {
    if (attribute.startsWith('symref-target:')) {
      symrefTarget = attribute.slice('symref-target:'.length);
    } else if (attribute.startsWith('peeled:')) {
      peeled = attribute.slice('peeled:'.length);
    }
  }
  if (oid === 'unborn') {
    return { name, unborn: true, ...(symrefTarget ? { symrefTarget } : {}) };
  }
  return {
    name,
    sha: oid,
    ...(symrefTarget ? { symrefTarget } : {}),
    ...(peeled ? { peeled } : {}),
  };
}

/**
 * Fold a protocol-v0 advertisement into the same shape ls-refs yields: the
 * first line carries `\0`-separated capabilities (including `symref=`), and
 * `<ref>^{}` lines are the peeled values of the preceding tag.
 */
function foldV0Line(refs: AdvertisedRef[], text: string, symrefs: Map<string, string>): void {
  const [oidAndName] = text.split('\0');
  const [oid, name] = oidAndName.split(' ');
  if (name === 'capabilities^{}') {
    return; // the null ref of an empty repository's advertisement
  }
  if (name?.endsWith('^{}')) {
    const bareName = name.slice(0, -3);
    const index = refs.findIndex((ref) => ref.name === bareName);
    if (index >= 0) {
      refs[index] = { ...refs[index], peeled: oid };
    }
    return;
  }
  const symrefTarget = symrefs.get(name);
  refs.push({ name, sha: oid, ...(symrefTarget ? { symrefTarget } : {}) });
}

function parseV0Capabilities(firstLine: string, symrefs: Map<string, string>): void {
  const nul = firstLine.indexOf('\0');
  if (nul < 0) {
    return;
  }
  for (const capability of firstLine.slice(nul + 1).split(' ')) {
    if (capability.startsWith('symref=')) {
      const [from, to] = capability.slice('symref='.length).split(':');
      if (from && to) {
        symrefs.set(from, to);
      }
    }
  }
}

/**
 * Run one ls-refs exchange on an open upload-pack channel. Resolves with the
 * advertised refs; the channel receives a goodbye flush but is not otherwise
 * closed — the transport owns the connection lifecycle.
 */
export function lsRefs(stream: UploadPackStream, options: LsRefsOptions): Promise<LsRefsResult> {
  const agent = options.agent ?? 'millwright-poller';
  return new Promise((resolve, reject) => {
    let settled = false;
    const settle = (outcome: () => void) => {
      if (!settled) {
        settled = true;
        outcome();
      }
    };

    let version: 0 | 2 | undefined;
    let unbornAdvertised = false;
    let requestSent = false;
    const refs: AdvertisedRef[] = [];
    const v0Symrefs = new Map<string, string>();
    let v0FirstLine: string | undefined;

    const onPacket = (packet: { type: string; text?: string }) => {
      if (packet.type === 'line') {
        const text = packet.text!;
        if (text.startsWith('ERR ') || text === 'ERR') {
          // Server-side refusal ("ERR Repository not found.") — can arrive as
          // the very first packet, before any version marker.
          throw new UploadPackRefusedError(text.slice(3).trim() || 'upload-pack refused');
        }
        if (version === undefined) {
          version = text === 'version 2' ? 2 : 0;
          if (version === 0) {
            if (!SHA_LINE.test(text)) {
              throw new GitProtocolError(`unexpected first packet from upload-pack: "${text}"`);
            }
            v0FirstLine = text;
            parseV0Capabilities(text, v0Symrefs);
            foldV0Line(refs, text, v0Symrefs);
          }
          return;
        }
        if (version === 2 && !requestSent) {
          if (text.startsWith('ls-refs')) {
            unbornAdvertised = text.includes('unborn');
          }
          return; // remaining capability advertisement lines
        }
        if (version === 2) {
          refs.push(parseV2RefLine(text));
        } else {
          foldV0Line(refs, text, v0Symrefs);
        }
        return;
      }
      if (packet.type !== 'flush') {
        return; // delim / response-end never appear at this layer's phase ends
      }
      if (version === 2 && !requestSent) {
        requestSent = true;
        stream.write(
          Buffer.concat([
            pktLine('command=ls-refs\n'),
            pktLine(`agent=${agent}\n`),
            DELIM_PKT,
            pktLine('peel\n'),
            pktLine('symrefs\n'),
            ...(unbornAdvertised ? [pktLine('unborn\n')] : []),
            ...options.refPrefixes.map((prefix) => pktLine(`ref-prefix ${prefix}\n`)),
            FLUSH_PKT,
          ]),
        );
        return;
      }
      // v2 response complete, or v0 advertisement fully read.
      stream.write(FLUSH_PKT);
      // v0 folds HEAD's symref from the capability line; re-fold in case HEAD
      // itself was the first line (parsed before its capabilities were known).
      if (version === 0 && v0FirstLine) {
        const headIndex = refs.findIndex((ref) => ref.name === 'HEAD' && !ref.symrefTarget);
        const target = v0Symrefs.get('HEAD');
        if (headIndex >= 0 && target) {
          refs[headIndex] = { ...refs[headIndex], symrefTarget: target };
        }
      }
      settle(() => resolve({ protocolVersion: version!, refs }));
    };

    const feed = createPktLineFeeder(onPacket);
    stream.on('data', (chunk) => {
      try {
        feed(chunk);
      } catch (err) {
        settle(() => reject(err));
      }
    });
    stream.on('error', (err) => settle(() => reject(err)));
    stream.on('close', () =>
      settle(() =>
        reject(new GitProtocolError('upload-pack channel closed before the response completed')),
      ),
    );
  });
}
