import {
  ConcurrencyGroupItem,
  EventIdentity,
  JobItem,
  JobStatus,
  RegistryItem,
  RunCoordinates,
  RunItem,
  SkipReason,
  concurrencyGroupKey,
  eventDedupeKey,
  formatRunId,
  jobKey,
  registryKey,
  runKey,
} from '@copperbox/millwright-state';
import { describe, expect, it } from 'vitest';
import {
  ArtifactCopier,
  BusEventEnvelope,
  ExecutionStarter,
  LauncherDeps,
  LauncherStore,
  RetryLater,
  processBusEvent,
} from '../src/runtime/launcher/launcher';

const SHA = 'c'.repeat(40);
const NOW = Date.parse('2026-08-12T06:00:00Z');

/**
 * In-memory LauncherStore with the same conditional-write semantics as the
 * DynamoDB implementation — every claim is atomic against current state.
 */
class MemoryStore implements LauncherStore {
  readonly events = new Map<string, Record<string, string>>();
  readonly registries = new Map<string, RegistryItem>();
  readonly counters = new Map<string, number>();
  readonly runs = new Map<string, RunItem>();
  readonly jobs = new Map<string, JobItem[]>();
  readonly groups = new Map<string, { running?: string; pending?: string }>();

  putRun(coords: RunCoordinates, overrides: Partial<RunItem> = {}): void {
    const key = runKey(coords);
    this.runs.set(key.pk + key.sk, {
      ...key,
      ...coords,
      status: 'FAILED',
      trigger: 'push',
      ref: 'refs/heads/main',
      sha: SHA,
      createdAt: new Date(NOW - 3_600_000).toISOString(),
      originalStartedAt: new Date(NOW - 3_600_000).toISOString(),
      expiresAt: 0,
      ...overrides,
    });
    this.counters.set(
      `${coords.repo}#${coords.workflow}`,
      Math.max(this.counters.get(`${coords.repo}#${coords.workflow}`) ?? 0, coords.runNumber),
    );
  }

  putJob(coords: RunCoordinates, job: string, status: JobStatus, skipReason?: SkipReason): void {
    const rows = this.jobs.get(runKey(coords).pk + runKey(coords).sk) ?? [];
    rows.push({
      ...jobKey(coords, job),
      ...coords,
      job,
      status,
      ...(skipReason ? { skipReason } : {}),
      expiresAt: 0,
    });
    this.jobs.set(runKey(coords).pk + runKey(coords).sk, rows);
  }

  putRegistry(repo: string, ref: string, workflows: Record<string, unknown>): void {
    const item: RegistryItem = {
      ...registryKey(repo, ref),
      repo,
      ref,
      schemaVersion: 1,
      workflows: workflows as RegistryItem['workflows'],
    };
    this.registries.set(item.pk + item.sk, item);
  }

  async claimEvent(identity: EventIdentity) {
    const key = eventDedupeKey(identity).pk;
    const existing = this.events.get(key);
    if (existing) {
      return { created: false, runIds: { ...existing } };
    }
    this.events.set(key, {});
    return { created: true, runIds: {} };
  }

  async getRegistryEntry(repo: string, ref: string) {
    const key = registryKey(repo, ref);
    return this.registries.get(key.pk + key.sk);
  }

  async nextRunNumber(repo: string, workflow: string) {
    const key = `${repo}#${workflow}`;
    const next = (this.counters.get(key) ?? 0) + 1;
    this.counters.set(key, next);
    return next;
  }

  async createRun(run: RunItem, identity: EventIdentity) {
    const record = this.events.get(eventDedupeKey(identity).pk);
    if (!record) {
      throw new Error('processing record missing');
    }
    const rk = runKey(run);
    if (this.runs.has(rk.pk + rk.sk)) {
      throw new Error(`run number reused: ${formatRunId(run)}`);
    }
    if (record[run.workflow]) {
      return false;
    }
    this.runs.set(rk.pk + rk.sk, run);
    record[run.workflow] = formatRunId(run);
    return true;
  }

  async getRun(coords: RunCoordinates) {
    const key = runKey(coords);
    const run = this.runs.get(key.pk + key.sk);
    return run ? { ...run } : undefined;
  }

  async listJobs(coords: RunCoordinates): Promise<readonly JobItem[]> {
    const key = runKey(coords);
    return this.jobs.get(key.pk + key.sk) ?? [];
  }

  async getGroup(group: string): Promise<ConcurrencyGroupItem | undefined> {
    const state = this.groups.get(group);
    return state ? { ...concurrencyGroupKey(group), ...state } : undefined;
  }

  async claimRunningSlot(group: string, runId: string) {
    const state = this.groups.get(group) ?? {};
    if (state.running && state.running !== runId) {
      return false;
    }
    this.groups.set(group, { ...state, running: runId });
    return true;
  }

  async claimPendingSlot(
    group: string,
    runId: string,
    opts: {
      expectedRunning: string;
      expectedPending?: string;
      markQueued: RunCoordinates;
      cancelReplaced?: RunCoordinates;
      requestCancelOf?: RunCoordinates;
    },
    nowMs: number,
  ) {
    const state = this.groups.get(group);
    if (state?.running !== opts.expectedRunning || state?.pending !== opts.expectedPending) {
      return false;
    }
    const queuedKey = runKey(opts.markQueued);
    const queued = this.runs.get(queuedKey.pk + queuedKey.sk);
    if (queued?.status !== 'PENDING') {
      return false;
    }
    if (opts.cancelReplaced) {
      const replacedKey = runKey(opts.cancelReplaced);
      const replaced = this.runs.get(replacedKey.pk + replacedKey.sk);
      if (replaced?.status !== 'QUEUED') {
        return false;
      }
      this.runs.set(replacedKey.pk + replacedKey.sk, {
        ...replaced,
        status: 'CANCELLED',
        reason: 'superseded',
        finishedAt: new Date(nowMs).toISOString(),
      });
    }
    if (opts.requestCancelOf) {
      const runningKey = runKey(opts.requestCancelOf);
      const running = this.runs.get(runningKey.pk + runningKey.sk);
      if (!running) {
        return false;
      }
      this.runs.set(runningKey.pk + runningKey.sk, { ...running, cancelRequested: true });
    }
    this.runs.set(queuedKey.pk + queuedKey.sk, { ...queued, status: 'QUEUED' });
    this.groups.set(group, { ...state, pending: runId });
    return true;
  }
}

class MemoryStarter implements ExecutionStarter {
  readonly startedRuns: string[] = [];
  readonly synthOnly: string[] = [];
  failNextStartRun = false;

  async startRun(run: RunItem) {
    if (this.failNextStartRun) {
      this.failNextStartRun = false;
      throw new Error('injected crash before StartExecution');
    }
    const id = formatRunId(run);
    if (!this.startedRuns.includes(id)) {
      this.startedRuns.push(id);
    }
  }

  async startSynthOnly(repo: string, ref: string, sha: string) {
    const key = `${repo}#${ref}#${sha}`;
    if (!this.synthOnly.includes(key)) {
      this.synthOnly.push(key);
    }
  }
}

class MemoryCopier implements ArtifactCopier {
  readonly copies: { from: string; to: string }[] = [];

  async copyPrefix(from: string, to: string): Promise<number> {
    this.copies.push({ from, to });
    return 1;
  }
}

function harness(): {
  deps: LauncherDeps;
  store: MemoryStore;
  starter: MemoryStarter;
  copier: MemoryCopier;
} {
  const store = new MemoryStore();
  const starter = new MemoryStarter();
  const copier = new MemoryCopier();
  return {
    store,
    starter,
    copier,
    deps: { store, starter, copier, metadataRetentionDays: 90, log: () => {} },
  };
}

function pushEvent(overrides: Record<string, unknown> = {}): BusEventEnvelope {
  return {
    source: 'millwright.poller',
    'detail-type': 'push',
    detail: {
      repo: 'octocat/app',
      ref: 'refs/heads/main',
      sha: SHA,
      defaultBranch: 'main',
      ...overrides,
    },
  };
}

const CI_ONLY = { ci: { triggers: [{ kind: 'push' }] } };

describe('validation precedes every write', () => {
  it('rejects a push from millwright.cli before touching the store', async () => {
    const { deps, store, starter } = harness();
    const result = await processBusEvent(
      deps,
      { ...pushEvent(), source: 'millwright.cli' },
      NOW,
    );
    expect(result).toMatchObject({ outcome: 'rejected', reason: expect.stringContaining('poller') });
    expect(store.events.size).toBe(0);
    expect(store.runs.size).toBe(0);
    expect(starter.startedRuns).toEqual([]);
    expect(starter.synthOnly).toEqual([]);
  });
});

describe('the happy path', () => {
  it('creates a PENDING run, records it on the processing record, and starts the execution', async () => {
    const { deps, store, starter } = harness();
    store.putRegistry('octocat/app', 'refs/heads/main', CI_ONLY);

    const result = await processBusEvent(deps, pushEvent(), NOW);
    expect(result).toEqual({
      outcome: 'runs',
      started: ['octocat/app#ci#1'],
      queued: [],
      settled: [],
    });
    const run = await store.getRun({ repo: 'octocat/app', workflow: 'ci', runNumber: 1 });
    expect(run).toMatchObject({
      status: 'PENDING',
      trigger: 'push',
      ref: 'refs/heads/main',
      sha: SHA,
      expiresAt: expect.any(Number),
    });
    expect(starter.startedRuns).toEqual(['octocat/app#ci#1']);
    const record = store.events.get(
      eventDedupeKey({ repo: 'octocat/app', ref: 'refs/heads/main', sha: SHA, kind: 'push' }).pk,
    );
    expect(record).toEqual({ ci: 'octocat/app#ci#1' });
  });

  it('runs every matched workflow with dense per-workflow numbers', async () => {
    const { deps, store, starter } = harness();
    store.putRegistry('octocat/app', 'refs/heads/main', {
      ci: { triggers: [{ kind: 'push' }] },
      lint: { triggers: [{ kind: 'push' }] },
    });
    await processBusEvent(deps, pushEvent(), NOW);
    expect(starter.startedRuns.sort()).toEqual(['octocat/app#ci#1', 'octocat/app#lint#1']);

    const second = pushEvent({ sha: 'd'.repeat(40) });
    await processBusEvent(deps, second, NOW + 1000);
    expect((await store.getRun({ repo: 'octocat/app', workflow: 'ci', runNumber: 2 }))?.sha).toBe(
      'd'.repeat(40),
    );
  });
});

describe('dedupe and crash convergence (acceptance criterion 2)', () => {
  it('a duplicate delivery yields one run and one execution', async () => {
    const { deps, store, starter } = harness();
    store.putRegistry('octocat/app', 'refs/heads/main', CI_ONLY);
    await processBusEvent(deps, pushEvent(), NOW);
    const again = await processBusEvent(deps, pushEvent(), NOW + 5000);
    expect(again).toEqual({
      outcome: 'runs',
      started: ['octocat/app#ci#1'],
      queued: [],
      settled: [],
    });
    expect(store.counters.get('octocat/app#ci')).toBe(1);
    expect(starter.startedRuns).toEqual(['octocat/app#ci#1']);
  });

  it('a crash after run-create followed by redelivery converges on the same run', async () => {
    const { deps, store, starter } = harness();
    store.putRegistry('octocat/app', 'refs/heads/main', CI_ONLY);
    starter.failNextStartRun = true;
    await expect(processBusEvent(deps, pushEvent(), NOW)).rejects.toThrow('injected crash');
    expect(store.runs.size).toBe(1);
    expect(starter.startedRuns).toEqual([]);

    const retry = await processBusEvent(deps, pushEvent(), NOW + 60_000);
    expect(retry).toEqual({
      outcome: 'runs',
      started: ['octocat/app#ci#1'],
      queued: [],
      settled: [],
    });
    expect(store.counters.get('octocat/app#ci')).toBe(1);
    expect(store.runs.size).toBe(1);
  });

  it('cron identities include the minute: double-fires coalesce, distinct minutes run', async () => {
    const { deps, store } = harness();
    store.putRegistry('octocat/app', 'refs/heads/main', {
      nightly: { triggers: [{ kind: 'cron', expression: '*/5 * * * *' }] },
    });
    const cron = (minute: string): BusEventEnvelope =>
      pushEvent({ workflow: 'nightly', minute }) as BusEventEnvelope & { 'detail-type': string };
    const at = (minute: string): BusEventEnvelope => ({
      ...cron(minute),
      'detail-type': 'cron',
    });
    await processBusEvent(deps, at('2026-08-12T06:00'), NOW);
    await processBusEvent(deps, at('2026-08-12T06:00'), NOW + 1000);
    await processBusEvent(deps, at('2026-08-12T06:05'), NOW + 300_000);
    expect(store.counters.get('octocat/app#nightly')).toBe(2);
  });
});

describe('registry fallback and bootstrap (acceptance criterion 3)', () => {
  it('falls back to the default branch map for a never-synthed ref', async () => {
    const { deps, starter, store } = harness();
    store.putRegistry('octocat/app', 'refs/heads/main', CI_ONLY);
    const result = await processBusEvent(
      deps,
      pushEvent({ ref: 'refs/heads/feature/fresh' }),
      NOW,
    );
    expect(result).toMatchObject({ outcome: 'runs', started: ['octocat/app#ci#1'] });
    expect(starter.synthOnly).toEqual([]);
  });

  it('starts a bootstrap synth and replays via redelivery on a full registry miss', async () => {
    const { deps, store, starter } = harness();
    // Never-synthed repo: no entry for the ref, none for the default branch.
    await expect(processBusEvent(deps, pushEvent(), NOW)).rejects.toThrow(RetryLater);
    expect(starter.synthOnly).toEqual([`octocat/app#refs/heads/main#${SHA}`]);
    expect(store.runs.size).toBe(0);

    // Redelivery while synth is still running: still waiting, still one synth.
    await expect(processBusEvent(deps, pushEvent(), NOW + 120_000)).rejects.toThrow(RetryLater);
    expect(starter.synthOnly).toHaveLength(1);

    // The bootstrap synth wrote the registry; the next redelivery runs normally.
    store.putRegistry('octocat/app', 'refs/heads/main', CI_ONLY);
    const replay = await processBusEvent(deps, pushEvent(), NOW + 240_000);
    expect(replay).toMatchObject({ outcome: 'runs', started: ['octocat/app#ci#1'] });
  });

  it('routes CLI bootstrap events straight to the synth-only path, idempotently', async () => {
    const { deps, starter, store } = harness();
    const bootstrap: BusEventEnvelope = {
      source: 'millwright.cli',
      'detail-type': 'bootstrap',
      detail: { repo: 'octocat/app', ref: 'refs/heads/main', sha: SHA, kind: 'bootstrap' },
    };
    expect(await processBusEvent(deps, bootstrap, NOW)).toEqual({
      outcome: 'bootstrap-started',
    });
    expect(await processBusEvent(deps, bootstrap, NOW + 1000)).toEqual({
      outcome: 'bootstrap-started',
    });
    expect(starter.synthOnly).toEqual([`octocat/app#refs/heads/main#${SHA}`]);
    expect(store.runs.size).toBe(0);
  });

  it('returns no-match when the registry matches nothing (no bootstrap)', async () => {
    const { deps, store, starter } = harness();
    store.putRegistry('octocat/app', 'refs/heads/main', {
      release: { triggers: [{ kind: 'tag', pattern: 'v*' }] },
    });
    expect(await processBusEvent(deps, pushEvent(), NOW)).toEqual({ outcome: 'no-match' });
    expect(starter.synthOnly).toEqual([]);
    expect(store.runs.size).toBe(0);
  });
});

describe('concurrency gating', () => {
  const GATED = {
    deploy: {
      triggers: [{ kind: 'push' }],
      concurrency: { group: 'deploy-${ref}', policy: 'queue' },
    },
  };

  it('claims the free running slot and starts', async () => {
    const { deps, store, starter } = harness();
    store.putRegistry('octocat/app', 'refs/heads/main', GATED);
    await processBusEvent(deps, pushEvent(), NOW);
    expect(store.groups.get('deploy-main')).toEqual({ running: 'octocat/app#deploy#1' });
    expect(starter.startedRuns).toEqual(['octocat/app#deploy#1']);
  });

  it('stamps the evaluated group key on every gated run record', async () => {
    const { deps, store } = harness();
    store.putRegistry('octocat/app', 'refs/heads/main', GATED);
    await processBusEvent(deps, pushEvent(), NOW);
    await processBusEvent(deps, pushEvent({ sha: 'd'.repeat(40) }), NOW + 1000);
    // Started and queued alike carry the key the decider/sweep release on.
    for (const runNumber of [1, 2]) {
      const run = await store.getRun({ repo: 'octocat/app', workflow: 'deploy', runNumber });
      expect(run?.concurrencyGroup).toBe('deploy-main');
    }
    // No group declared → no key stamped (unlimited concurrency).
    const plain = harness();
    plain.store.putRegistry('octocat/app', 'refs/heads/main', CI_ONLY);
    await processBusEvent(plain.deps, pushEvent(), NOW);
    const run = await plain.store.getRun({ repo: 'octocat/app', workflow: 'ci', runNumber: 1 });
    expect(run?.concurrencyGroup).toBeUndefined();
  });

  it('queues behind an occupied group and replaces the pending waiter (slot of one)', async () => {
    const { deps, store, starter } = harness();
    store.putRegistry('octocat/app', 'refs/heads/main', GATED);
    await processBusEvent(deps, pushEvent(), NOW); // #1 running

    const second = await processBusEvent(deps, pushEvent({ sha: 'd'.repeat(40) }), NOW + 1000);
    expect(second).toMatchObject({ outcome: 'runs', queued: ['octocat/app#deploy#2'] });
    expect((await store.getRun({ repo: 'octocat/app', workflow: 'deploy', runNumber: 2 }))?.status).toBe(
      'QUEUED',
    );

    const third = await processBusEvent(deps, pushEvent({ sha: 'e'.repeat(40) }), NOW + 2000);
    expect(third).toMatchObject({ outcome: 'runs', queued: ['octocat/app#deploy#3'] });
    expect(store.groups.get('deploy-main')).toEqual({
      running: 'octocat/app#deploy#1',
      pending: 'octocat/app#deploy#3',
    });
    const replaced = await store.getRun({ repo: 'octocat/app', workflow: 'deploy', runNumber: 2 });
    expect(replaced).toMatchObject({ status: 'CANCELLED', reason: 'superseded' });
    expect(starter.startedRuns).toEqual(['octocat/app#deploy#1']);
  });

  it('supersede requests cancellation of the in-flight run and waits in pending', async () => {
    const { deps, store, starter } = harness();
    store.putRegistry('octocat/app', 'refs/heads/main', {
      deploy: {
        triggers: [{ kind: 'push' }],
        concurrency: { group: 'deploy', policy: 'supersede' },
      },
    });
    await processBusEvent(deps, pushEvent(), NOW);
    await processBusEvent(deps, pushEvent({ sha: 'd'.repeat(40) }), NOW + 1000);
    const first = await store.getRun({ repo: 'octocat/app', workflow: 'deploy', runNumber: 1 });
    expect(first?.cancelRequested).toBe(true);
    expect(store.groups.get('deploy')).toEqual({
      running: 'octocat/app#deploy#1',
      pending: 'octocat/app#deploy#2',
    });
    expect(starter.startedRuns).toEqual(['octocat/app#deploy#1']);
  });

  it('loses the running-slot race cleanly: re-reads and queues behind the winner', async () => {
    const { deps, store, starter } = harness();
    store.putRegistry('octocat/app', 'refs/heads/main', GATED);
    // Between this launcher's read (slot free) and its conditional claim, a
    // concurrent launcher claims the running slot for another run.
    const claimRunning = store.claimRunningSlot.bind(store);
    let injected = false;
    store.claimRunningSlot = async (group, runId) => {
      if (!injected) {
        injected = true;
        await claimRunning(group, 'octocat/lib#deploy#9');
      }
      return claimRunning(group, runId);
    };

    const result = await processBusEvent(deps, pushEvent(), NOW);
    expect(result).toMatchObject({ outcome: 'runs', queued: ['octocat/app#deploy#1'] });
    expect(store.groups.get('deploy-main')).toEqual({
      running: 'octocat/lib#deploy#9',
      pending: 'octocat/app#deploy#1',
    });
    expect(starter.startedRuns).toEqual([]);
  });

  it('loses the pending-slot race cleanly: the winner is superseded, never double-claimed', async () => {
    const { deps, store } = harness();
    store.putRegistry('octocat/app', 'refs/heads/main', GATED);
    await processBusEvent(deps, pushEvent(), NOW); // #1 running
    // A concurrent launcher's waiter (another repo, same deployment-global
    // group) lands between this launcher's read and its conditional claim.
    store.putRun({ repo: 'octocat/lib', workflow: 'deploy', runNumber: 1 }, { status: 'QUEUED' });
    const claimPending = store.claimPendingSlot.bind(store);
    let injected = false;
    store.claimPendingSlot = async (group, runId, opts, nowMs) => {
      if (!injected) {
        injected = true;
        store.groups.set(group, { ...store.groups.get(group)!, pending: 'octocat/lib#deploy#1' });
      }
      return claimPending(group, runId, opts, nowMs);
    };

    const result = await processBusEvent(deps, pushEvent({ sha: 'd'.repeat(40) }), NOW + 1000);
    // The first conditional write fails on the stale read; the retry adopts
    // slot-of-one semantics and replaces the winner instead of stacking up.
    expect(result).toMatchObject({ outcome: 'runs', queued: ['octocat/app#deploy#2'] });
    expect(store.groups.get('deploy-main')).toEqual({
      running: 'octocat/app#deploy#1',
      pending: 'octocat/app#deploy#2',
    });
    expect(
      await store.getRun({ repo: 'octocat/lib', workflow: 'deploy', runNumber: 1 }),
    ).toMatchObject({ status: 'CANCELLED', reason: 'superseded' });
  });

  it('redelivery after queueing leaves the queued run untouched', async () => {
    const { deps, store, starter } = harness();
    store.putRegistry('octocat/app', 'refs/heads/main', GATED);
    await processBusEvent(deps, pushEvent(), NOW);
    const dup = pushEvent({ sha: 'd'.repeat(40) });
    await processBusEvent(deps, dup, NOW + 1000);
    const redelivered = await processBusEvent(deps, dup, NOW + 2000);
    expect(redelivered).toEqual({
      outcome: 'runs',
      started: [],
      queued: [],
      settled: ['octocat/app#deploy#2'],
    });
    expect(store.counters.get('octocat/app#deploy')).toBe(2);
    expect(starter.startedRuns).toEqual(['octocat/app#deploy#1']);
  });
});

describe('rerun (spec §7.7)', () => {
  const SOURCE: RunCoordinates = { repo: 'octocat/app', workflow: 'ci', runNumber: 41 };

  function rerunEvent(overrides: Record<string, unknown> = {}): BusEventEnvelope {
    return {
      source: 'millwright.cli',
      'detail-type': 'rerun',
      detail: {
        repo: 'octocat/app',
        ref: 'refs/heads/main',
        sha: SHA,
        workflow: 'ci',
        sourceRunNumber: 41,
        nonce: 'nonce-1',
        ...overrides,
      },
    };
  }

  it('creates a fresh-numbered run from the stored model and starts it resumed', async () => {
    const { deps, store, starter, copier } = harness();
    store.putRegistry('octocat/app', 'refs/heads/main', CI_ONLY);
    store.putRun(SOURCE, { status: 'FAILED', sha: 'e'.repeat(40), ref: 'refs/heads/release' });

    const result = await processBusEvent(deps, rerunEvent(), NOW);
    expect(result).toEqual({
      outcome: 'runs',
      started: ['octocat/app#ci#42'],
      queued: [],
      settled: [],
    });
    const run = await store.getRun({ repo: 'octocat/app', workflow: 'ci', runNumber: 42 });
    expect(run).toMatchObject({
      status: 'PENDING',
      trigger: 'rerun',
      rerunOf: 'octocat/app#ci#41',
      // The source RECORD is authoritative for what is rerun.
      ref: 'refs/heads/release',
      sha: 'e'.repeat(40),
    });
    expect(run?.reuseJobs).toBeUndefined();
    expect(starter.startedRuns).toEqual(['octocat/app#ci#42']);
    // Plain rerun copies only the stored model + packaged source.
    expect(copier.copies).toEqual([
      { from: 'runs/octocat/app/ci/41/in/', to: 'runs/octocat/app/ci/42/in/' },
    ]);
  });

  it('--failed reuses succeeded outputs and reruns failed jobs plus their skipped dependents', async () => {
    const { deps, store, copier } = harness();
    store.putRegistry('octocat/app', 'refs/heads/main', CI_ONLY);
    store.putRun(SOURCE, { status: 'FAILED' });
    store.putJob(SOURCE, 'build', 'SUCCEEDED');
    store.putJob(SOURCE, 'test', 'FAILED');
    store.putJob(SOURCE, 'deploy', 'SKIPPED', 'upstream_failed');

    const result = await processBusEvent(deps, rerunEvent({ failedOnly: true }), NOW);
    expect(result).toMatchObject({ outcome: 'runs', started: ['octocat/app#ci#42'] });
    const run = await store.getRun({ repo: 'octocat/app', workflow: 'ci', runNumber: 42 });
    expect(run?.reuseJobs).toEqual(['build']);
    expect(copier.copies).toEqual([
      { from: 'runs/octocat/app/ci/41/in/', to: 'runs/octocat/app/ci/42/in/' },
      { from: 'runs/octocat/app/ci/41/out/build/', to: 'runs/octocat/app/ci/42/out/build/' },
    ]);
  });

  it('rejects --failed when nothing failed', async () => {
    const { deps, store, starter } = harness();
    store.putRun(SOURCE, { status: 'SUCCEEDED' });
    store.putJob(SOURCE, 'build', 'SUCCEEDED');
    store.putJob(SOURCE, 'guard', 'SKIPPED', 'skip_if');

    const result = await processBusEvent(deps, rerunEvent({ failedOnly: true }), NOW);
    expect(result).toMatchObject({
      outcome: 'rejected',
      reason: expect.stringContaining('nothing failed'),
    });
    expect(starter.startedRuns).toEqual([]);
    expect(store.counters.get('octocat/app#ci')).toBe(41);
  });

  it('rejects a missing or non-terminal source run', async () => {
    const { deps, store } = harness();
    expect(await processBusEvent(deps, rerunEvent(), NOW)).toMatchObject({
      outcome: 'rejected',
      reason: expect.stringContaining('does not exist'),
    });
    store.putRun(SOURCE, { status: 'RUNNING' });
    expect(await processBusEvent(deps, rerunEvent({ nonce: 'nonce-2' }), NOW)).toMatchObject({
      outcome: 'rejected',
      reason: expect.stringContaining('not terminal'),
    });
  });

  it('redeliveries coalesce on the nonce while new invocations start fresh runs', async () => {
    const { deps, store, starter } = harness();
    store.putRegistry('octocat/app', 'refs/heads/main', CI_ONLY);
    store.putRun(SOURCE, { status: 'FAILED' });

    await processBusEvent(deps, rerunEvent(), NOW);
    const redelivered = await processBusEvent(deps, rerunEvent(), NOW + 1000);
    expect(redelivered).toEqual({
      outcome: 'runs',
      started: ['octocat/app#ci#42'],
      queued: [],
      settled: [],
    });
    expect(store.counters.get('octocat/app#ci')).toBe(42);

    await processBusEvent(deps, rerunEvent({ nonce: 'nonce-2' }), NOW + 2000);
    expect(store.counters.get('octocat/app#ci')).toBe(43);
    expect(starter.startedRuns).toEqual(['octocat/app#ci#42', 'octocat/app#ci#43']);
  });

  it('gates through concurrency groups like any other run', async () => {
    const { deps, store, starter } = harness();
    store.putRegistry('octocat/app', 'refs/heads/main', {
      ci: { triggers: [{ kind: 'push' }], concurrency: { group: 'ci-${ref}', policy: 'queue' } },
    });
    store.putRun(SOURCE, { status: 'FAILED' });
    store.groups.set('ci-main', { running: 'octocat/app#ci#40' });

    const result = await processBusEvent(deps, rerunEvent(), NOW);
    expect(result).toMatchObject({ outcome: 'runs', queued: ['octocat/app#ci#42'] });
    expect(store.groups.get('ci-main')).toEqual({
      running: 'octocat/app#ci#40',
      pending: 'octocat/app#ci#42',
    });
    expect(starter.startedRuns).toEqual([]);
  });

  it('fails closed on an uninterpretable registry concurrency entry', async () => {
    const { deps, store, starter } = harness();
    store.putRegistry('octocat/app', 'refs/heads/main', {
      ci: { triggers: [{ kind: 'push' }], concurrency: { group: '', policy: 'sometimes' } },
    });
    store.putRun(SOURCE, { status: 'FAILED' });
    const result = await processBusEvent(deps, rerunEvent(), NOW);
    expect(result).toMatchObject({ outcome: 'rejected' });
    expect(starter.startedRuns).toEqual([]);
  });
});
