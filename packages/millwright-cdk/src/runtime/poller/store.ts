import {
  CIRCUIT_BREAKER_KEY,
  RECONCILED_HOST_KEYS_KEY,
  quarantineKey,
  refMapKey,
} from '@copperbox/millwright-state';
import type { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import { DeleteCommand, GetCommand, PutCommand } from '@aws-sdk/lib-dynamodb';
import { CircuitBreakerState, CLOSED_BREAKER, QuarantineState } from './degradation';
import { PollingStore, StoredRefMap } from './poller';
import { RefMap, decodeRefMap, encodeRefMap } from './ref-map';

/**
 * The poller's polling-table access (spec §9.4, C10): per-repo compressed
 * ref-map and quarantine items, the deployment-wide circuit-breaker item, and
 * the reconciled-host-keys item. Reserved concurrency 1 makes the poller the
 * table's only writer for these rows, so plain reads and writes suffice —
 * except the ref-map read, which is strongly consistent so a tick never
 * diffs against anything older than the previous tick's commit.
 */
export class DynamoPollingStore implements PollingStore {
  constructor(
    private readonly client: DynamoDBDocumentClient,
    private readonly tableName: string,
  ) {}

  async getRefMap(repo: string): Promise<StoredRefMap | undefined> {
    const result = await this.client.send(
      new GetCommand({
        TableName: this.tableName,
        Key: refMapKey(repo),
        ConsistentRead: true,
      }),
    );
    const item = result.Item as
      | { encoding?: string; map?: Uint8Array; defaultBranch?: string }
      | undefined;
    if (!item) {
      return undefined;
    }
    if (item.encoding !== 'gzip-json' || !(item.map instanceof Uint8Array)) {
      // Unreadable map: surface it — the caller re-baselines, which can drop
      // the crash window's events, so this must never pass silently.
      throw new Error(`unreadable ref-map item for ${repo} (encoding "${item.encoding}")`);
    }
    return {
      map: decodeRefMap(item.map),
      ...(item.defaultBranch ? { defaultBranch: item.defaultBranch } : {}),
    };
  }

  async commitRefMap(
    repo: string,
    map: RefMap,
    defaultBranch: string | undefined,
    nowMs: number,
  ): Promise<void> {
    const encoded = encodeRefMap(map);
    await this.client.send(
      new PutCommand({
        TableName: this.tableName,
        Item: {
          ...refMapKey(repo),
          encoding: 'gzip-json',
          map: encoded,
          refCount: Object.keys(map).length,
          ...(defaultBranch ? { defaultBranch } : {}),
          updatedAt: new Date(nowMs).toISOString(),
        },
      }),
    );
  }

  async getQuarantine(repo: string): Promise<QuarantineState | undefined> {
    const result = await this.client.send(
      new GetCommand({ TableName: this.tableName, Key: quarantineKey(repo) }),
    );
    if (!result.Item) {
      return undefined;
    }
    const { reason, quarantinedAt, attempts, retryAt } = result.Item as QuarantineState;
    return { reason, quarantinedAt, attempts, retryAt };
  }

  async putQuarantine(repo: string, state: QuarantineState): Promise<void> {
    await this.client.send(
      new PutCommand({
        TableName: this.tableName,
        Item: { ...quarantineKey(repo), ...state },
      }),
    );
  }

  async clearQuarantine(repo: string): Promise<void> {
    await this.client.send(
      new DeleteCommand({ TableName: this.tableName, Key: quarantineKey(repo) }),
    );
  }

  async getCircuitBreaker(): Promise<CircuitBreakerState> {
    const result = await this.client.send(
      new GetCommand({ TableName: this.tableName, Key: CIRCUIT_BREAKER_KEY }),
    );
    if (!result.Item) {
      return CLOSED_BREAKER;
    }
    const { state, openedAt, probeAttempts, nextProbeAt } = result.Item as CircuitBreakerState;
    return state === 'open'
      ? { state, openedAt, probeAttempts, nextProbeAt }
      : CLOSED_BREAKER;
  }

  async putCircuitBreaker(state: CircuitBreakerState): Promise<void> {
    await this.client.send(
      new PutCommand({
        TableName: this.tableName,
        Item: { ...CIRCUIT_BREAKER_KEY, ...state },
      }),
    );
  }

  async getReconciledHostKeys(): Promise<string | undefined> {
    const result = await this.client.send(
      new GetCommand({ TableName: this.tableName, Key: RECONCILED_HOST_KEYS_KEY }),
    );
    const keys = (result.Item as { keys?: string } | undefined)?.keys;
    return typeof keys === 'string' && keys ? keys : undefined;
  }

  async putReconciledHostKeys(keys: string, nowMs: number): Promise<void> {
    await this.client.send(
      new PutCommand({
        TableName: this.tableName,
        Item: {
          ...RECONCILED_HOST_KEYS_KEY,
          keys,
          updatedAt: new Date(nowMs).toISOString(),
        },
      }),
    );
  }
}
