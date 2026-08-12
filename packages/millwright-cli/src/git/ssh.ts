/**
 * SSH transport for git-protocol work (spec §6.1): pure-JS ssh2 exec of
 * `git-upload-pack`, authenticated with a repo's read-only deploy key, host
 * key verified against the pins seeded from GitHub's /meta endpoint — an
 * unpinned key is a hard failure, never a prompt.
 */

import { timingSafeEqual } from 'node:crypto';
import { Client } from 'ssh2';
import { UploadPackStream } from './ls-refs';

export class HostKeyMismatchError extends Error {}

/** owner/repo, as GitHub names them — also keeps the exec string quotable. */
const REPO_PATTERN = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;

/**
 * Parse the host-keys parameter into raw public-key blobs. Accepts
 * known_hosts-style `github.com <algo> <base64>` lines and the bare
 * `<algo> <base64>` lines GitHub's /meta `ssh_keys` field serves.
 */
export function parseHostKeyPins(value: string): Buffer[] {
  const pins: Buffer[] = [];
  for (const line of value.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) {
      continue;
    }
    const fields = trimmed.split(/\s+/);
    const base64 = fields[0].startsWith('ssh-') || fields[0].startsWith('ecdsa-')
      ? fields[1]
      : fields[2];
    if (base64) {
      pins.push(Buffer.from(base64, 'base64'));
    }
  }
  return pins;
}

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

function matchesAnyPin(blob: Buffer, pins: readonly Buffer[]): boolean {
  return pins.some((pin) => pin.length === blob.length && timingSafeEqual(pin, blob));
}

/**
 * Open an SSH connection to the repo's upload-pack endpoint, hand the exec'd
 * channel to `fn`, and always close the connection afterwards.
 */
export async function withUploadPack<T>(
  options: SshUploadPackOptions,
  fn: (stream: UploadPackStream) => Promise<T>,
  clientFactory: () => SshClientLike = () => new Client() as unknown as SshClientLike,
): Promise<T> {
  if (!REPO_PATTERN.test(options.repo)) {
    throw new Error(`invalid repo name "${options.repo}" — expected owner/repo`);
  }
  if (options.hostKeyPins.length === 0) {
    throw new HostKeyMismatchError(
      'no pinned host keys available — run "millwright setup" (or refresh-host-keys) first',
    );
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
    client.on('error', (err) => reject(pinFailure ?? err));
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
