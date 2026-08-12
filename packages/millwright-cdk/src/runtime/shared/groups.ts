import {
  ConcurrencyGroupItem,
  RunCoordinates,
  RunItem,
  concurrencyGroupKey,
  expiresAtAfterDays,
  parseRunId,
  runKey,
} from '@copperbox/millwright-state';
import type { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import { GetCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb';
import { isConditionalCheckFailure } from './jobs';

/**
 * Concurrency-group slot release and hand-off (spec §8.4), shared by the
 * decider (on run completion) and the sweep (crash repair). The launcher owns
 * the claim side; this module owns the release side: when a group's running
 * run is finished, hand the execution slot to the pending run — START its
 * execution first, THEN promote it into the running slot. The start is
 * idempotent under its deterministic execution name, so a crash between the
 * two steps leaves the group showing a terminal running run — exactly the
 * state the 1-minute sweep detects and re-converges. The inverse order would
 * park a never-started run in the running slot, which nothing repairs.
 */

export interface GroupSlotStore {
  getGroup(group: string): Promise<ConcurrencyGroupItem | undefined>;
  getRun(coords: RunCoordinates): Promise<RunItem | undefined>;
  /**
   * Hand the running slot to the pending run: running := pending, pending
   * cleared — conditioned on the exact state the caller just read.
   */
  promotePending(
    group: string,
    expected: { readonly running: string; readonly pending: string },
    nowMs: number,
  ): Promise<boolean>;
  /** Free the running slot, conditioned on it still holding this run and no waiter. */
  clearRunning(group: string, expectedRunning: string): Promise<boolean>;
  /** Drop a pending occupant whose run record no longer exists. */
  dropPending(
    group: string,
    expected: { readonly running: string; readonly pending: string },
  ): Promise<boolean>;
}

/** The `states:StartExecution` capability the decider and sweep hold. */
export interface PendingRunStarter {
  startRun(run: RunItem): Promise<void>;
}

export interface GroupReleaseDeps {
  readonly store: GroupSlotStore;
  readonly starter: PendingRunStarter;
  readonly log: (message: string, fields?: Record<string, unknown>) => void;
}

export type GroupReleaseOutcome = 'not-held' | 'cleared' | 'handed-off' | 'contended';

const RELEASE_ATTEMPTS = 5;

/**
 * Release `finishedRunId`'s hold on the group and start the pending run.
 * Every write is conditioned on the state just read, so racing releasers
 * (decider vs sweep) and racing claimers (a launcher replacing the pending
 * slot mid-release) converge: a lost condition re-reads and retries.
 * 'contended' after bounded attempts is safe to walk away from — the sweep
 * re-runs this same convergence within a minute.
 */
export async function releaseGroupSlot(
  deps: GroupReleaseDeps,
  group: string,
  finishedRunId: string,
  nowMs: number,
): Promise<GroupReleaseOutcome> {
  const { store, starter, log } = deps;
  for (let attempt = 1; attempt <= RELEASE_ATTEMPTS; attempt++) {
    const state = await store.getGroup(group);
    if (state?.running !== finishedRunId) {
      return 'not-held'; // already handed off (or never claimed) — done
    }
    const pending = state.pending;
    if (!pending) {
      if (await store.clearRunning(group, finishedRunId)) {
        return 'cleared';
      }
      continue; // a waiter arrived since the read — hand off to it instead
    }
    const pendingRun = await store.getRun(parseRunId(pending));
    if (!pendingRun) {
      log('pending run record missing; dropping it from the group', { group, pending });
      await store.dropPending(group, { running: finishedRunId, pending });
      continue;
    }
    await starter.startRun(pendingRun);
    if (await store.promotePending(group, { running: finishedRunId, pending }, nowMs)) {
      return 'handed-off';
    }
    // The pending occupant changed under us (superseded by a newer arrival);
    // the started execution finds its run CANCELLED and ends immediately.
  }
  return 'contended';
}

/** The conditional slot writes over the `GROUP#<key>` item (spec §9.1). */
export class DynamoGroupSlotStore implements GroupSlotStore {
  constructor(
    protected readonly client: DynamoDBDocumentClient,
    protected readonly tableName: string,
    protected readonly metadataRetentionDays: number,
  ) {}

  async getGroup(group: string): Promise<ConcurrencyGroupItem | undefined> {
    const result = await this.client.send(
      new GetCommand({
        TableName: this.tableName,
        Key: concurrencyGroupKey(group),
        ConsistentRead: true,
      }),
    );
    return result.Item as ConcurrencyGroupItem | undefined;
  }

  async getRun(coords: RunCoordinates): Promise<RunItem | undefined> {
    const result = await this.client.send(
      new GetCommand({
        TableName: this.tableName,
        Key: runKey(coords),
        ConsistentRead: true,
      }),
    );
    return result.Item as RunItem | undefined;
  }

  async promotePending(
    group: string,
    expected: { readonly running: string; readonly pending: string },
    nowMs: number,
  ): Promise<boolean> {
    return this.conditionalSlotWrite(group, {
      UpdateExpression: 'SET #running = :pending, #ttl = :expiresAt REMOVE #pending',
      ConditionExpression: '#running = :running AND #pending = :pending',
      ExpressionAttributeNames: { '#running': 'running', '#pending': 'pending', '#ttl': 'expiresAt' },
      ExpressionAttributeValues: {
        ':running': expected.running,
        ':pending': expected.pending,
        ':expiresAt': expiresAtAfterDays(nowMs, this.metadataRetentionDays),
      },
    });
  }

  async clearRunning(group: string, expectedRunning: string): Promise<boolean> {
    return this.conditionalSlotWrite(group, {
      UpdateExpression: 'REMOVE #running',
      ConditionExpression: '#running = :running AND attribute_not_exists(#pending)',
      ExpressionAttributeNames: { '#running': 'running', '#pending': 'pending' },
      ExpressionAttributeValues: { ':running': expectedRunning },
    });
  }

  async dropPending(
    group: string,
    expected: { readonly running: string; readonly pending: string },
  ): Promise<boolean> {
    return this.conditionalSlotWrite(group, {
      UpdateExpression: 'REMOVE #pending',
      ConditionExpression: '#running = :running AND #pending = :pending',
      ExpressionAttributeNames: { '#running': 'running', '#pending': 'pending' },
      ExpressionAttributeValues: { ':running': expected.running, ':pending': expected.pending },
    });
  }

  private async conditionalSlotWrite(
    group: string,
    update: {
      UpdateExpression: string;
      ConditionExpression: string;
      ExpressionAttributeNames: Record<string, string>;
      ExpressionAttributeValues: Record<string, unknown>;
    },
  ): Promise<boolean> {
    try {
      await this.client.send(
        new UpdateCommand({
          TableName: this.tableName,
          Key: concurrencyGroupKey(group),
          ...update,
        }),
      );
      return true;
    } catch (err) {
      if (isConditionalCheckFailure(err)) {
        return false;
      }
      throw err;
    }
  }
}
