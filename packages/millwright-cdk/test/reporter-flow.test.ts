import {
  CheckStateItem,
  DesiredCheckState,
  checkStateKey,
  desiredJobCheck,
  serializeDesiredCheckState,
  withMetadataTtl,
} from '@copperbox/millwright-state';
import { describe, expect, it } from 'vitest';
import {
  CheckCoordinates,
  CheckPublisher,
  PublishFailure,
  ReporterStore,
  reconcileCheck,
  sweepChecks,
} from '../src/runtime/reporter/reporter';

const NOW = Date.parse('2026-08-12T06:00:00Z');
const SHA = 'a'.repeat(40);
const COORDS: CheckCoordinates = { repo: 'octocat/app', sha: SHA, context: 'ci / build' };

const DESIRED: DesiredCheckState = desiredJobCheck('queued', { runId: 'ci#142', steps: [] });
const DESIRED_SERIALIZED = serializeDesiredCheckState(DESIRED);

function item(overrides: Partial<CheckStateItem> = {}): CheckStateItem {
  return withMetadataTtl(
    {
      ...checkStateKey(COORDS.repo, COORDS.sha, COORDS.context),
      repo: COORDS.repo,
      sha: COORDS.sha,
      context: COORDS.context,
      desired: DESIRED_SERIALIZED,
      desiredAt: new Date(NOW - 60_000).toISOString(),
      ownerRun: 'ci#142',
      ownerRunNumber: 142,
      ...overrides,
    },
    NOW,
  );
}

class FakeStore implements ReporterStore {
  reportedWrites: Array<{ seenDesired: string; checkRunId?: number }> = [];
  failureWrites: Array<{ backoffAttempts: number; nextAttemptAt: string }> = [];
  recordedCheckRunIds: number[] = [];
  abandonedWrites = 0;
  markReportedResult: 'applied' | 'stale' = 'applied';
  unconverged: CheckStateItem[] = [];

  constructor(private items: Map<string, CheckStateItem | undefined> = new Map()) {}

  set(coords: CheckCoordinates, value: CheckStateItem | undefined): void {
    this.items.set(JSON.stringify(coords), value);
  }

  async getCheck(coords: CheckCoordinates): Promise<CheckStateItem | undefined> {
    return this.items.get(JSON.stringify(coords));
  }

  async markReported(
    _coords: CheckCoordinates,
    seenDesired: string,
    checkRunId?: number,
  ): Promise<'applied' | 'stale'> {
    this.reportedWrites.push({ seenDesired, checkRunId });
    return this.markReportedResult;
  }

  async recordCheckRunId(_coords: CheckCoordinates, checkRunId: number): Promise<void> {
    this.recordedCheckRunIds.push(checkRunId);
  }

  async recordAttemptFailure(
    _coords: CheckCoordinates,
    backoffAttempts: number,
    nextAttemptAt: string,
  ): Promise<void> {
    this.failureWrites.push({ backoffAttempts, nextAttemptAt });
  }

  async markAbandoned(): Promise<void> {
    this.abandonedWrites += 1;
  }

  async listUnconverged(): Promise<CheckStateItem[]> {
    return this.unconverged;
  }
}

class FakePublisher implements CheckPublisher {
  calls: Array<{ coords: CheckCoordinates; desired: DesiredCheckState; checkRunId?: number }> = [];
  failure?: Error;
  returnedCheckRunId?: number;

  async publish(
    coords: CheckCoordinates,
    desired: DesiredCheckState,
    checkRunId?: number,
  ): Promise<{ checkRunId?: number }> {
    this.calls.push({ coords, desired, checkRunId });
    if (this.failure) {
      throw this.failure;
    }
    return { checkRunId: this.returnedCheckRunId };
  }
}

function deps(store: FakeStore, publisher: FakePublisher) {
  return { store, publisher, log: () => {} };
}

describe('reconcileCheck', () => {
  it('publishes the latest desired state and marks it reported with the minted check run id', async () => {
    const store = new FakeStore();
    store.set(COORDS, item());
    const publisher = new FakePublisher();
    publisher.returnedCheckRunId = 777;

    const disposition = await reconcileCheck(deps(store, publisher), COORDS, NOW);

    expect(disposition).toBe('reported');
    expect(publisher.calls).toHaveLength(1);
    expect(publisher.calls[0].desired).toEqual(DESIRED);
    expect(publisher.calls[0].checkRunId).toBeUndefined();
    expect(store.reportedWrites).toEqual([{ seenDesired: DESIRED_SERIALIZED, checkRunId: 777 }]);
  });

  it('passes the stored check run id through so one check run is updated, never duplicated', async () => {
    const store = new FakeStore();
    store.set(COORDS, item({ checkRunId: 777 }));
    const publisher = new FakePublisher();
    publisher.returnedCheckRunId = 777;

    await reconcileCheck(deps(store, publisher), COORDS, NOW);

    expect(publisher.calls[0].checkRunId).toBe(777);
  });

  it('does nothing when reported already equals desired', async () => {
    const store = new FakeStore();
    store.set(COORDS, item({ reported: DESIRED_SERIALIZED }));
    const publisher = new FakePublisher();

    expect(await reconcileCheck(deps(store, publisher), COORDS, NOW)).toBe('converged');
    expect(publisher.calls).toHaveLength(0);
  });

  it('skips missing items, desired-less items and abandoned items', async () => {
    const store = new FakeStore();
    const publisher = new FakePublisher();
    expect(await reconcileCheck(deps(store, publisher), COORDS, NOW)).toBe('missing');

    store.set(COORDS, item({ desired: undefined }));
    expect(await reconcileCheck(deps(store, publisher), COORDS, NOW)).toBe('no-desired');

    store.set(COORDS, item({ abandoned: true }));
    expect(await reconcileCheck(deps(store, publisher), COORDS, NOW)).toBe('abandoned-skip');
    expect(publisher.calls).toHaveLength(0);
  });

  it('backs off exponentially on a publish failure, honoring Retry-After as a floor', async () => {
    const store = new FakeStore();
    store.set(COORDS, item({ backoffAttempts: 2 }));
    const publisher = new FakePublisher();
    publisher.failure = new PublishFailure('rate limited', 3600);

    const disposition = await reconcileCheck(deps(store, publisher), COORDS, NOW);

    expect(disposition).toBe('backed-off');
    expect(store.failureWrites).toEqual([
      { backoffAttempts: 3, nextAttemptAt: new Date(NOW + 3600_000).toISOString() },
    ]);
  });

  it('computes the doubled delay when no Retry-After is present', async () => {
    const store = new FakeStore();
    store.set(COORDS, item({ backoffAttempts: 1 }));
    const publisher = new FakePublisher();
    publisher.failure = new Error('connect ETIMEDOUT');

    await reconcileCheck(deps(store, publisher), COORDS, NOW);

    // attempts so far = 1 → next delay 2 min, doubling toward the 15 min cap.
    expect(store.failureWrites).toEqual([
      { backoffAttempts: 2, nextAttemptAt: new Date(NOW + 120_000).toISOString() },
    ]);
  });

  it('waits out a future nextAttemptAt without calling GitHub', async () => {
    const store = new FakeStore();
    store.set(COORDS, item({ nextAttemptAt: new Date(NOW + 60_000).toISOString() }));
    const publisher = new FakePublisher();

    expect(await reconcileCheck(deps(store, publisher), COORDS, NOW)).toBe('waiting');
    expect(publisher.calls).toHaveLength(0);
  });

  it('retries once the backoff deadline has passed', async () => {
    const store = new FakeStore();
    store.set(COORDS, item({ nextAttemptAt: new Date(NOW - 1000).toISOString(), backoffAttempts: 3 }));
    const publisher = new FakePublisher();

    expect(await reconcileCheck(deps(store, publisher), COORDS, NOW)).toBe('reported');
    expect(publisher.calls).toHaveLength(1);
  });

  it('abandons an item unconverged for 7 days instead of retrying forever', async () => {
    const store = new FakeStore();
    store.set(
      COORDS,
      item({
        desiredAt: new Date(NOW - 8 * 24 * 3600 * 1000).toISOString(),
        nextAttemptAt: new Date(NOW + 60_000).toISOString(),
      }),
    );
    const publisher = new FakePublisher();

    expect(await reconcileCheck(deps(store, publisher), COORDS, NOW)).toBe('abandoned');
    expect(store.abandonedWrites).toBe(1);
    expect(publisher.calls).toHaveLength(0);
  });

  it('keeps the minted check run id when the desired state moved on mid-flight', async () => {
    const store = new FakeStore();
    store.set(COORDS, item());
    store.markReportedResult = 'stale';
    const publisher = new FakePublisher();
    publisher.returnedCheckRunId = 888;

    const disposition = await reconcileCheck(deps(store, publisher), COORDS, NOW);

    expect(disposition).toBe('superseded');
    expect(store.recordedCheckRunIds).toEqual([888]);
  });

  it('abandons an item whose desired payload cannot be parsed', async () => {
    const store = new FakeStore();
    store.set(COORDS, item({ desired: '{"status":"nope"}' }));
    const publisher = new FakePublisher();

    expect(await reconcileCheck(deps(store, publisher), COORDS, NOW)).toBe('abandoned');
    expect(publisher.calls).toHaveLength(0);
  });
});

describe('sweepChecks', () => {
  it('reconciles every unconverged item, one publish per check', async () => {
    const store = new FakeStore();
    const other: CheckCoordinates = { ...COORDS, context: 'ci / test' };
    store.set(COORDS, item());
    store.set(other, item({ ...checkStateKey(other.repo, other.sha, other.context), context: other.context }));
    store.unconverged = [
      (await store.getCheck(COORDS))!,
      (await store.getCheck(other))!,
      item({ nextAttemptAt: new Date(NOW + 60_000).toISOString(), context: 'ci / lint' }),
    ];
    store.set({ ...COORDS, context: 'ci / lint' }, store.unconverged[2]);
    const publisher = new FakePublisher();

    const summary = await sweepChecks(deps(store, publisher), NOW);

    expect(publisher.calls).toHaveLength(2);
    expect(summary.scanned).toBe(3);
    expect(summary.dispositions).toEqual({ reported: 2, waiting: 1 });
  });
});
