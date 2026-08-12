import { RegistryItem, registryKey } from '@copperbox/millwright-state';
import { describe, expect, it } from 'vitest';
import { CronTickMetrics } from '../src/runtime/poller/metrics';
import {
  CronPollingStore,
  CronRegistryReader,
  CronTickDeps,
  runCronTick,
} from '../src/runtime/poller/cron-tick';
import { BusEmitter, BusEvent, StoredRefMap } from '../src/runtime/poller/poller';

const sha = (seed: number) => seed.toString(16).padStart(40, '0');
const HEAD = sha(0xabc);
/** 2026-08-12T06:02:30Z. */
const NOW = Date.UTC(2026, 7, 12, 6, 2, 30);

type Journal = string[];

class FakeCronStore implements CronPollingStore {
  refMaps = new Map<string, StoredRefMap>();
  lastFired = new Map<string, string>();

  constructor(private readonly journal: Journal = []) {}

  async getRefMap(repo: string): Promise<StoredRefMap | undefined> {
    return this.refMaps.get(repo);
  }
  async getCronLastFired(
    repo: string,
    workflow: string,
    expression: string,
  ): Promise<string | undefined> {
    return this.lastFired.get(`${repo}|${workflow}|${expression}`);
  }
  async putCronLastFired(
    repo: string,
    workflow: string,
    expression: string,
    minute: string,
  ): Promise<void> {
    this.journal.push(`commit:${repo}|${workflow}|${expression}=${minute}`);
    this.lastFired.set(`${repo}|${workflow}|${expression}`, minute);
  }
}

class FakeRegistry implements CronRegistryReader {
  entries = new Map<string, RegistryItem>();

  put(repo: string, ref: string, workflows: Record<string, { triggers: unknown }>): void {
    this.entries.set(`${repo}|${ref}`, {
      ...registryKey(repo, ref),
      repo,
      ref,
      schemaVersion: 1,
      workflows,
    });
  }
  async getRegistryEntry(repo: string, ref: string): Promise<RegistryItem | undefined> {
    return this.entries.get(`${repo}|${ref}`);
  }
}

class FakeEmitter implements BusEmitter {
  emitted: { repo: string; events: readonly BusEvent[]; defaultBranch?: string }[] = [];
  failures = 0;

  constructor(private readonly journal: Journal = []) {}

  async emit(repo: string, events: readonly BusEvent[], defaultBranch?: string): Promise<void> {
    if (this.failures > 0) {
      this.failures--;
      throw new Error('PutEvents failed');
    }
    this.journal.push(`emit:${repo}|${events.map((e) => `${e.workflow}@${e.minute}`).join(',')}`);
    this.emitted.push({ repo, events, defaultBranch });
  }
}

function harness(nowMs = NOW) {
  const journal: Journal = [];
  const store = new FakeCronStore(journal);
  const registry = new FakeRegistry();
  const emitter = new FakeEmitter(journal);
  const metrics: CronTickMetrics[] = [];
  const logs: string[] = [];
  const deps: CronTickDeps = {
    store,
    registry,
    emitter,
    listRepos: async () => ['octo/app'],
    metrics: (m) => metrics.push(m),
    log: (message) => logs.push(message),
    now: () => nowMs,
  };
  store.refMaps.set('octo/app', {
    map: { 'refs/heads/main': HEAD, 'refs/heads/dev': sha(2) },
    defaultBranch: 'main',
  });
  registry.put('octo/app', 'refs/heads/main', {
    nightly: { triggers: [{ kind: 'cron', expression: '*/5 * * * *' }] },
  });
  return { deps, store, registry, emitter, metrics, logs, journal };
}

describe('runCronTick', () => {
  it('fires a fresh entry for the current minute when it matches, ref-less on the default branch', async () => {
    const { deps, emitter } = harness(Date.UTC(2026, 7, 12, 6, 5, 12));
    const summary = await runCronTick(deps);
    expect(summary.eventsEmitted).toBe(1);
    expect(emitter.emitted).toEqual([
      {
        repo: 'octo/app',
        defaultBranch: 'main',
        events: [
          {
            kind: 'cron',
            ref: 'refs/heads/main',
            sha: HEAD,
            workflow: 'nightly',
            minute: '2026-08-12T06:05',
          },
        ],
      },
    ]);
  });

  it('does not fire a fresh entry on a non-matching minute, and writes nothing', async () => {
    const { deps, emitter, store } = harness(Date.UTC(2026, 7, 12, 6, 2, 30));
    const summary = await runCronTick(deps);
    expect(summary.eventsEmitted).toBe(0);
    expect(emitter.emitted).toEqual([]);
    expect(store.lastFired.size).toBe(0);
  });

  it('catches up with exactly one fire after an outage — the latest matching minute', async () => {
    // Last fired 03:00; poller down for ~3 hours; 36 matching minutes elapsed.
    const { deps, store, emitter } = harness(Date.UTC(2026, 7, 12, 6, 2, 30));
    store.lastFired.set('octo/app|nightly|*/5 * * * *', '2026-08-12T03:00');
    const summary = await runCronTick(deps);
    expect(summary.eventsEmitted).toBe(1);
    expect(emitter.emitted[0].events[0].minute).toBe('2026-08-12T06:00');
    expect(store.lastFired.get('octo/app|nightly|*/5 * * * *')).toBe('2026-08-12T06:00');
  });

  it('fires once per matching minute across consecutive ticks and stays quiet between', async () => {
    const { store, registry, emitter } = harness();
    const tickAt = (ms: number) =>
      runCronTick({
        store,
        registry,
        emitter,
        listRepos: async () => ['octo/app'],
        metrics: () => {},
        log: () => {},
        now: () => ms,
      });
    await tickAt(Date.UTC(2026, 7, 12, 6, 5, 2));
    await tickAt(Date.UTC(2026, 7, 12, 6, 6, 2));
    await tickAt(Date.UTC(2026, 7, 12, 6, 7, 2));
    await tickAt(Date.UTC(2026, 7, 12, 6, 10, 2));
    expect(emitter.emitted.map((e) => e.events[0].minute)).toEqual([
      '2026-08-12T06:05',
      '2026-08-12T06:10',
    ]);
  });

  it('emits before committing, and an emit failure leaves last-fired untouched for re-emit', async () => {
    const { deps, store, emitter, journal } = harness(Date.UTC(2026, 7, 12, 6, 5, 0));
    emitter.failures = 1;
    const failed = await runCronTick(deps);
    expect(failed.errors).toBe(1);
    expect(store.lastFired.size).toBe(0);

    const retried = await runCronTick(deps);
    expect(retried.eventsEmitted).toBe(1);
    expect(journal).toEqual([
      'emit:octo/app|nightly@2026-08-12T06:05',
      'commit:octo/app|nightly|*/5 * * * *=2026-08-12T06:05',
    ]);
  });

  it('evaluates several cron entries independently, keyed per (workflow, expression)', async () => {
    const { deps, registry, emitter, store } = harness(Date.UTC(2026, 7, 12, 6, 0, 3));
    registry.put('octo/app', 'refs/heads/main', {
      nightly: {
        triggers: [
          { kind: 'cron', expression: '*/5 * * * *' },
          { kind: 'cron', expression: '0 6 * * *' },
        ],
      },
      hourly: { triggers: [{ kind: 'cron', expression: '0 * * * *' }, { kind: 'push' }] },
    });
    const summary = await runCronTick(deps);
    expect(summary.entriesEvaluated).toBe(3);
    expect(summary.eventsEmitted).toBe(3);
    expect(emitter.emitted.map((e) => `${e.events[0].workflow}:${e.events[0].minute}`)).toEqual([
      'hourly:2026-08-12T06:00',
      'nightly:2026-08-12T06:00',
      'nightly:2026-08-12T06:00',
    ]);
    expect(store.lastFired.get('octo/app|nightly|0 6 * * *')).toBe('2026-08-12T06:00');
    expect(store.lastFired.get('octo/app|hourly|0 * * * *')).toBe('2026-08-12T06:00');
  });

  it('skips an invalid expression, counting and logging it, without firing', async () => {
    const { deps, registry, emitter, logs } = harness(Date.UTC(2026, 7, 12, 6, 5, 0));
    registry.put('octo/app', 'refs/heads/main', {
      broken: { triggers: [{ kind: 'cron', expression: 'every 5 minutes' }] },
    });
    const summary = await runCronTick(deps);
    expect(summary.invalidExpressions).toBe(1);
    expect(summary.eventsEmitted).toBe(0);
    expect(emitter.emitted).toEqual([]);
    expect(logs.some((l) => l.includes('cron expression'))).toBe(true);
  });

  it('re-baselines an unparseable stored last-fired minute instead of firing a backlog', async () => {
    const { deps, store, emitter } = harness(Date.UTC(2026, 7, 12, 6, 5, 0));
    store.lastFired.set('octo/app|nightly|*/5 * * * *', 'garbage');
    const summary = await runCronTick(deps);
    expect(summary.eventsEmitted).toBe(1);
    expect(emitter.emitted[0].events[0].minute).toBe('2026-08-12T06:05');
  });

  it('skips repos with no stored ref map, no default branch, or no registry entry', async () => {
    const { deps, store, registry, emitter } = harness(Date.UTC(2026, 7, 12, 6, 5, 0));
    store.refMaps.delete('octo/app');
    expect((await runCronTick(deps)).eventsEmitted).toBe(0);

    store.refMaps.set('octo/app', { map: { 'refs/heads/main': HEAD } });
    expect((await runCronTick(deps)).eventsEmitted).toBe(0);

    store.refMaps.set('octo/app', { map: { 'refs/heads/main': HEAD }, defaultBranch: 'main' });
    registry.entries.clear();
    expect((await runCronTick(deps)).eventsEmitted).toBe(0);
    expect(emitter.emitted).toEqual([]);
  });

  it('skips a workflow whose registry triggers cannot be interpreted', async () => {
    const { deps, registry, emitter, logs } = harness(Date.UTC(2026, 7, 12, 6, 5, 0));
    registry.put('octo/app', 'refs/heads/main', {
      mangled: { triggers: 'not-an-array' },
    });
    const summary = await runCronTick(deps);
    expect(summary.eventsEmitted).toBe(0);
    expect(emitter.emitted).toEqual([]);
    expect(logs.some((l) => l.includes('uninterpretable'))).toBe(true);
  });

  it('a repo-local failure never blocks other repos', async () => {
    const { store, registry, emitter, journal } = harness(Date.UTC(2026, 7, 12, 6, 5, 0));
    store.refMaps.set('octo/lib', {
      map: { 'refs/heads/main': sha(9) },
      defaultBranch: 'main',
    });
    registry.put('octo/lib', 'refs/heads/main', {
      nightly: { triggers: [{ kind: 'cron', expression: '*/5 * * * *' }] },
    });
    const failingRegistry: CronRegistryReader = {
      getRegistryEntry: (repo, ref) => {
        if (repo === 'octo/app') {
          throw new Error('dynamo down');
        }
        return registry.getRegistryEntry(repo, ref);
      },
    };
    const summary = await runCronTick({
      store,
      registry: failingRegistry,
      emitter,
      listRepos: async () => ['octo/app', 'octo/lib'],
      metrics: () => {},
      log: () => {},
      now: () => Date.UTC(2026, 7, 12, 6, 5, 0),
    });
    expect(summary.errors).toBe(1);
    expect(summary.eventsEmitted).toBe(1);
    expect(emitter.emitted[0].repo).toBe('octo/lib');
    expect(journal).toContain('emit:octo/lib|nightly@2026-08-12T06:05');
  });

  it('emits tick metrics', async () => {
    const { deps, metrics } = harness(Date.UTC(2026, 7, 12, 6, 5, 0));
    await runCronTick(deps);
    expect(metrics).toHaveLength(1);
    expect(metrics[0]).toMatchObject({
      CronEntriesEvaluated: 1,
      CronEventsEmitted: 1,
      CronInvalidExpressions: 0,
      CronErrors: 0,
    });
  });
});
