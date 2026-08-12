import {
  CIRCUIT_BREAKER_KEY,
  RECONCILED_HOST_KEYS_KEY,
  prEtagKey,
  quarantineKey,
  refMapKey,
} from '@copperbox/millwright-state';
import { DeleteCommand, GetCommand, PutCommand } from '@aws-sdk/lib-dynamodb';
import { describe, expect, it } from 'vitest';
import { CLOSED_BREAKER } from '../src/runtime/poller/degradation';
import { DynamoPollingStore } from '../src/runtime/poller/store';

/** In-memory polling table keyed by `pk|sk`. */
class FakeDocumentClient {
  readonly items = new Map<string, Record<string, unknown>>();

  async send(command: unknown): Promise<unknown> {
    if (command instanceof GetCommand) {
      const { pk, sk } = command.input.Key as { pk: string; sk: string };
      return { Item: this.items.get(`${pk}|${sk}`) };
    }
    if (command instanceof PutCommand) {
      const item = command.input.Item as { pk: string; sk: string };
      this.items.set(`${item.pk}|${item.sk}`, { ...item });
      return {};
    }
    if (command instanceof DeleteCommand) {
      const { pk, sk } = command.input.Key as { pk: string; sk: string };
      this.items.delete(`${pk}|${sk}`);
      return {};
    }
    throw new Error('unexpected command');
  }
}

const NOW = 1_760_000_000_000;
const sha = (seed: number) => seed.toString(16).padStart(40, '0');

describe('DynamoPollingStore', () => {
  it('round-trips the compressed ref map with its default branch', async () => {
    const client = new FakeDocumentClient();
    const store = new DynamoPollingStore(client as never, 'mw-polling');
    const map = { 'refs/heads/main': sha(1), 'refs/tags/v1': sha(2) };

    await store.commitRefMap('octo/app', map, 'main', NOW);
    const item = client.items.get(`${refMapKey('octo/app').pk}|${refMapKey('octo/app').sk}`)!;
    expect(item.encoding).toBe('gzip-json');
    expect(item.refCount).toBe(2);
    expect(item.map).toBeInstanceOf(Uint8Array);
    // Compressed at rest — never the raw JSON.
    expect(Buffer.from(item.map as Uint8Array).toString()).not.toContain('refs/heads');

    expect(await store.getRefMap('octo/app')).toEqual({ map, defaultBranch: 'main' });
    expect(await store.getRefMap('octo/other')).toBeUndefined();
  });

  it('rejects an unreadable ref-map item instead of silently re-baselining', async () => {
    const client = new FakeDocumentClient();
    const key = refMapKey('octo/app');
    client.items.set(`${key.pk}|${key.sk}`, { ...key, encoding: 'raw', map: 'not-binary' });
    const store = new DynamoPollingStore(client as never, 'mw-polling');
    await expect(store.getRefMap('octo/app')).rejects.toThrow('unreadable ref-map item');
  });

  it('stores, reads and clears quarantine markers', async () => {
    const client = new FakeDocumentClient();
    const store = new DynamoPollingStore(client as never, 'mw-polling');
    const state = {
      reason: 'Repository not found.',
      quarantinedAt: new Date(NOW).toISOString(),
      attempts: 1,
      retryAt: NOW + 60_000,
    };
    await store.putQuarantine('octo/app', state);
    expect(await store.getQuarantine('octo/app')).toEqual(state);
    expect(client.items.has(`${quarantineKey('octo/app').pk}|${quarantineKey('octo/app').sk}`)).toBe(
      true,
    );
    await store.clearQuarantine('octo/app');
    expect(await store.getQuarantine('octo/app')).toBeUndefined();
  });

  it('defaults the circuit breaker to closed and round-trips an open one', async () => {
    const client = new FakeDocumentClient();
    const store = new DynamoPollingStore(client as never, 'mw-polling');
    expect(await store.getCircuitBreaker()).toEqual(CLOSED_BREAKER);

    const open = {
      state: 'open' as const,
      openedAt: new Date(NOW).toISOString(),
      probeAttempts: 2,
      nextProbeAt: NOW + 240_000,
    };
    await store.putCircuitBreaker(open);
    expect(await store.getCircuitBreaker()).toEqual(open);
    expect(client.items.has(`${CIRCUIT_BREAKER_KEY.pk}|${CIRCUIT_BREAKER_KEY.sk}`)).toBe(true);
  });

  it('round-trips the tier-2 PR snapshot under the PR-ETAG sort key', async () => {
    const client = new FakeDocumentClient();
    const store = new DynamoPollingStore(client as never, 'mw-polling');
    expect(await store.getPrSnapshot('octo/app')).toBeUndefined();

    const snapshot = {
      etag: 'W/"abc"',
      heads: { '7': sha(1), '12': sha(2) },
      forkPrPolicy: true,
      backoff: { attempts: 2, retryAt: NOW + 120_000 },
    };
    await store.putPrSnapshot('octo/app', snapshot, NOW);
    expect(await store.getPrSnapshot('octo/app')).toEqual(snapshot);
    const item = client.items.get(`${prEtagKey('octo/app').pk}|${prEtagKey('octo/app').sk}`)!;
    expect(item.openPrCount).toBe(2);
    expect(item.updatedAt).toBe(new Date(NOW).toISOString());

    // Absent etag and backoff stay absent on the round-trip.
    await store.putPrSnapshot('octo/app', { heads: {}, forkPrPolicy: false }, NOW);
    expect(await store.getPrSnapshot('octo/app')).toEqual({ heads: {}, forkPrPolicy: false });
  });

  it('re-baselines a malformed PR snapshot silently (tier 2 is best-effort)', async () => {
    const client = new FakeDocumentClient();
    const key = prEtagKey('octo/app');
    client.items.set(`${key.pk}|${key.sk}`, { ...key, etag: 42, heads: 'nope' });
    const store = new DynamoPollingStore(client as never, 'mw-polling');
    expect(await store.getPrSnapshot('octo/app')).toBeUndefined();
  });

  it('round-trips reconciled host keys', async () => {
    const client = new FakeDocumentClient();
    const store = new DynamoPollingStore(client as never, 'mw-polling');
    expect(await store.getReconciledHostKeys()).toBeUndefined();
    await store.putReconciledHostKeys('ssh-ed25519 AAAA', NOW);
    expect(await store.getReconciledHostKeys()).toBe('ssh-ed25519 AAAA');
    expect(
      client.items.has(`${RECONCILED_HOST_KEYS_KEY.pk}|${RECONCILED_HOST_KEYS_KEY.sk}`),
    ).toBe(true);
  });
});
