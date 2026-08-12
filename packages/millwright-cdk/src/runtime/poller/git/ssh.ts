/**
 * SSH transport for the tier-1 poller (spec §6.1): pure-JS ssh2 exec of
 * `git-upload-pack`, authenticated with the repo's read-only deploy key, host
 * key verified against the pinned blobs — an unpinned key is a hard failure,
 * never a prompt.
 *
 * Errors are classified for the poller's degradation machinery (spec §6.3):
 * `HostKeyMismatchError` feeds the rotation-reconcile path,
 * `SshAuthRejectedError` feeds per-repo quarantine, and anything else is a
 * transport failure counting toward the circuit-breaker quorum.
 */

import { timingSafeEqual } from 'node:crypto';
import { Client } from 'ssh2';
import { UploadPackStream } from './ls-refs';

export class HostKeyMismatchError extends Error {
  constructor(
    message: string,
    /** The raw host-key blob the server presented, for rotation confirmation. */
    readonly presentedKey: Buffer,
  ) {
    super(message);
  }
}

/** The server rejected the deploy key — a per-repo quarantine condition. */
export class SshAuthRejectedError extends Error {}

/** owner/repo, as GitHub names them — also keeps the exec string quotable. */
const REPO_PATTERN = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;

export interface SshUploadPackOptions {
  /** `owner/repo` to exec `git-upload-pack` against. */
  readonly repo: string;
  /** OpenSSH-format private key — the repo's deploy key. */
  readonly privateKey: string;
  /** Raw host-key blobs from the pinned host-keys parameter. */
  readonly hostKeyPins: readonly Buffer[];
  /** @default github.com */
  readonly host?: string;
  /** @default 22 */
  readonly port?: number;
  /** Connection-level timeout. @default 20s */
  readonly readyTimeoutMs?: number;
}

/** The slice of ssh2's Client this transport uses; tests inject a fake. */
export interface SshClientLike {
  connect(config: Record<string, unknown>): unknown;
  exec(
    command: string,
    options: { env: Record<string, string> },
    callback: (err: Error | undefined, stream: UploadPackStream) => void,
  ): unknown;
  end(): void;
  on(event: 'ready', listener: () => void): unknown;
  on(event: 'error', listener: (err: Error) => void): unknown;
}

export type SshClientFactory = () => SshClientLike;

function matchesAnyPin(blob: Buffer, pins: readonly Buffer[]): boolean {
  return pins.some((pin) => pin.length === blob.length && timingSafeEqual(pin, blob));
}

/** ssh2 reports a refused publickey auth with this level/wording. */
function isAuthRejection(err: Error): boolean {
  return (
    (err as { level?: string }).level === 'client-authentication' ||
    /authentication methods failed/i.test(err.message)
  );
}

/**
 * Open an SSH connection to the repo's upload-pack endpoint, hand the exec'd
 * channel to `fn`, and always close the connection afterwards.
 */
export async function withUploadPack<T>(
  options: SshUploadPackOptions,
  fn: (stream: UploadPackStream) => Promise<T>,
  clientFactory: SshClientFactory = () => new Client() as unknown as SshClientLike,
): Promise<T> {
  if (!REPO_PATTERN.test(options.repo)) {
    throw new Error(`invalid repo name "${options.repo}" — expected owner/repo`);
  }
  if (options.hostKeyPins.length === 0) {
    throw new Error('no host-key pins available — refusing to connect unverified');
  }

  const client = clientFactory();
  let pinFailure: HostKeyMismatchError | undefined;

  const stream = await new Promise<UploadPackStream>((resolve, reject) => {
    client.on('ready', () => {
      client.exec(
        `git-upload-pack '${options.repo}'`,
        { env: { GIT_PROTOCOL: 'version=2' } },
        (err, execStream) => (err ? reject(err) : resolve(execStream)),
      );
    });
    client.on('error', (err) => {
      if (pinFailure) {
        reject(pinFailure);
      } else if (isAuthRejection(err)) {
        reject(new SshAuthRejectedError(`${options.repo}: deploy key rejected (${err.message})`));
      } else {
        reject(err);
      }
    });
    client.connect({
      host: options.host ?? 'github.com',
      port: options.port ?? 22,
      username: 'git',
      privateKey: options.privateKey,
      readyTimeout: options.readyTimeoutMs ?? 20_000,
      hostVerifier: (blob: Buffer) => {
        if (matchesAnyPin(blob, options.hostKeyPins)) {
          return true;
        }
        pinFailure = new HostKeyMismatchError(
          `${options.host ?? 'github.com'} presented a host key matching none of the ` +
            `${options.hostKeyPins.length} pinned keys — refusing to authenticate`,
          Buffer.from(blob),
        );
        return false;
      },
    });
  }).catch((err) => {
    client.end();
    throw err;
  });

  try {
    return await fn(stream);
  } finally {
    client.end();
  }
}
