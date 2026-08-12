/**
 * Host-key pinning (spec §6.1): pins live in the SSM host-keys parameter,
 * seeded from GitHub's /meta at setup; the keys GitHub publishes are compiled
 * in as day-one defaults so a fresh deployment polls before setup completes.
 *
 * On a mismatch the poller confirms rotation against /meta over HTTPS: a
 * presented key that /meta vouches for is auto-reconciled (persisted to the
 * polling table — the poller has no config-plane write access — and alarmed
 * on via metric); anything else hard-fails the repo's poll. `millwright
 * refresh-host-keys` is the manual hatch that rewrites the SSM pin itself.
 */

import { timingSafeEqual } from 'node:crypto';

/**
 * github.com's published SSH host keys, verified against
 * https://api.github.com/meta on 2026-08-12. Defaults only — the SSM pin,
 * once seeded, takes precedence.
 */
export const COMPILED_IN_HOST_KEYS: readonly string[] = [
  'ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIOMqqnkVzrm0SdG6UOoqKLsabgH5C9okWi0dh2l9GKJl',
  'ecdsa-sha2-nistp256 AAAAE2VjZHNhLXNoYTItbmlzdHAyNTYAAAAIbmlzdHAyNTYAAABBBEmKSENjQEezOmxkZMy7opKgwFB9nkt5YRrYMjNuG5N87uRgg6CLrbo5wAdT/y6v0mKV0U2w0WZ2YB/++Tpockg=',
  'ssh-rsa AAAAB3NzaC1yc2EAAAADAQABAAABgQCj7ndNxQowgcQnjshcLrqPEiiphnt+VTTvDP6mHBL9j1aNUkY4Ue1gvwnGLVlOhGeYrnZaMgRK6+PKCUXaDbC7qtbW8gIkhL7aGCsOr/C56SJMy/BCZfxd1nWzAOxSDPgVsmerOBYfNqltV9/hWCqBywINIR+5dIg6JTJ72pcEpEjcYgXkE2YEFXV1JHnsKgbLWNlhScqb2UmyRkQyytRLtL+38TGxkxCflmO+5Z8CSSNY7GidjMIZ7Q4zMjA2n1nGrlTDkzwDCsw+wqFPGQA179cnfGWOWRVruj16z6XyvxvjJwbz0wQZ75XK5tKSb7FNyeIEs4TT4jk+S4dhPeAUC5y+bDYirYgM4GC7uEnztnZyaVWQ7B381AK4Qdrwt51ZqExKbQpTUNn+EjqoTwvqNj4kqx5QUCI0ThS/YkOxJCXmPUWZbhjpCg56i+2aB6CmK2JGhn57K5mj0MNdBXA4/WnwH6XoPWJzK5Nyu2zB3nAZp+S5hpQs+p1vN1/wsjk=',
];

/**
 * Parse a host-keys value into raw public-key blobs. Accepts
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
    const base64 =
      fields[0].startsWith('ssh-') || fields[0].startsWith('ecdsa-') ? fields[1] : fields[2];
    if (base64) {
      pins.push(Buffer.from(base64, 'base64'));
    }
  }
  return pins;
}

/**
 * Effective pins for a tick: the SSM parameter when seeded (else the
 * compiled-in defaults), plus any pins a previous confirmed rotation
 * reconciled into the polling table.
 */
export function resolveHostKeyPins(
  ssmValue: string | undefined,
  reconciledValue: string | undefined,
): Buffer[] {
  const base = ssmValue?.trim() ? ssmValue : COMPILED_IN_HOST_KEYS.join('\n');
  const pins = parseHostKeyPins(base);
  if (reconciledValue?.trim()) {
    for (const pin of parseHostKeyPins(reconciledValue)) {
      if (!pins.some((existing) => existing.length === pin.length && timingSafeEqual(existing, pin))) {
        pins.push(pin);
      }
    }
  }
  return pins;
}

/** The slice of GitHub's /meta answer rotation confirmation needs. */
export interface GithubMeta {
  readonly ssh_keys?: readonly string[];
}

export type MetaFetch = () => Promise<GithubMeta>;

/** Unauthenticated /meta fetch — the poller Lambda is non-VPC with egress. */
export async function fetchGithubMeta(): Promise<GithubMeta> {
  const response = await fetch('https://api.github.com/meta', {
    headers: { accept: 'application/vnd.github+json', 'user-agent': 'millwright-poller' },
  });
  if (!response.ok) {
    throw new Error(`GET /meta returned ${response.status}`);
  }
  return (await response.json()) as GithubMeta;
}

export interface RotationConfirmation {
  readonly confirmed: boolean;
  /** /meta's full current key set, for persisting when confirmed. */
  readonly currentKeys: readonly string[];
}

/**
 * A mismatching host key is a confirmed rotation ONLY when GitHub's /meta
 * endpoint (a separate, TLS-authenticated channel) advertises that exact
 * key. Anything else stays a hard failure.
 */
export async function confirmRotation(
  presentedKey: Buffer,
  fetchMeta: MetaFetch,
): Promise<RotationConfirmation> {
  const meta = await fetchMeta();
  const currentKeys = meta.ssh_keys ?? [];
  const confirmed = parseHostKeyPins(currentKeys.join('\n')).some(
    (key) => key.length === presentedKey.length && timingSafeEqual(key, presentedKey),
  );
  return { confirmed, currentKeys };
}
