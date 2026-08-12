import { describe, expect, it } from 'vitest';
import {
  CLOSED_BREAKER,
  CircuitBreakerState,
  QUARANTINE_BASE_RETRY_MS,
  QuarantineState,
} from '../src/runtime/poller/degradation';
import { LsRefsResult, UploadPackRefusedError } from '../src/runtime/poller/git/ls-refs';
import { HostKeyMismatchError, SshAuthRejectedError } from '../src/runtime/poller/git/ssh';
import { COMPILED_IN_HOST_KEYS, GithubMeta, parseHostKeyPins } from '../src/runtime/poller/host-keys';
import { TickMetrics } from '../src/runtime/poller/metrics';
import {
  BusEmitter,
  ConfigPlane,
  PollerDeps,
  PollingStore,
  StoredRefMap,
  mapWithConcurrency,
  runTick,
} from '../src/runtime/poller/poller';
import { RefEvent, RefMap } from '../src/runtime/poller/ref-map';

const NOW = 1_760_000_000_000;
const CADENCE = 60_000;
const sha = (seed: number) => seed.toString(16).padStart(40, '0');

const advertisement = (refs: Record<string, string>, defaultBranch = 'main'): LsRefsResult => ({
  protocolVersion: 2,
  refs: [
    {
      name: 'HEAD',
      sha: refs[`refs/heads/${defaultBranch}`] ?? sha(0),
      symrefTarget: `refs/heads/${defaultBranch}`,
    },
    ...Object.entries(refs).map(([name, oid]) => ({ name, sha: oid })),
  ],
});

/** Shared operations journal so tests can assert emit-before-commit ordering. */
type Journal = string[];

class FakeStore implements PollingStore {
  refMaps = new Map<string, StoredRefMap>();
  quarantines = new Map<string, QuarantineState>();
  breaker: CircuitBreakerState = CLOSED_BREAKER;
  breakerWrites: CircuitBreakerState[] = [];
  reconciledKeys: string | undefined;

  constructor(private readonly journal: Journal = []) {}

  async getRefMap(repo: string): Promise<StoredRefMap | undefined> {
    return this.refMaps.get(repo);
  }
  async commitRefMap(repo: string, map: RefMap, defaultBranch: string | undefined): Promise<void> {
    this.journal.push(`commit:${repo}`);
    this.refMaps.set(repo, { map, ...(defaultBranch ? { defaultBranch } : {}) });
  }
  async getQuarantine(repo: string): Promise<QuarantineState | undefined> {
    return this.quarantines.get(repo);
  }
  async putQuarantine(repo: string, state: QuarantineState): Promise<void> {
    this.quarantines.set(repo, state);
  }
  async clearQuarantine(repo: string): Promise<void> {
    this.quarantines.delete(repo);
  }
  async getCircuitBreaker(): Promise<CircuitBreakerState> {
    return this.breaker;
  }
  async putCircuitBreaker(state: CircuitBreakerState): Promise<void> {
    this.breaker = state;
    this.breakerWrites.push(state);
  }
  async getReconciledHostKeys(): Promise<string | undefined> {
    return this.reconciledKeys;
  }
  async putReconciledHostKeys(keys: string): Promise<void> {
    this.reconciledKeys = keys;
  }
}

class FakeConfig implements ConfigPlane {
  evicted: string[] = [];
  constructor(
    public repos: string[],
    public deployKeys = new Map<string, string>(),
    public hostKeysParameter: string | undefined = undefined,
  ) {}

  async listRepos(): Promise<string[]> {
    return [...this.repos];
  }
  async getDeployKeys(repos: readonly string[]): Promise<Map<string, string>> {
    const keys = new Map<string, string>();
    for (const repo of repos) {
      const key = this.deployKeys.get(repo);
      if (key) {
        keys.set(repo, key);
      }
    }
    return keys;
  }
  evictDeployKey(repo: string): void {
    this.evicted.push(repo);
  }
  async getHostKeysParameter(): Promise<string | undefined> {
    return this.hostKeysParameter;
  }
}

class FakeEmitter implements BusEmitter {
  emitted: { repo: string; events: readonly RefEvent[]; defaultBranch?: string }[] = [];
  failFor = new Set<string>();

  constructor(private readonly journal: Journal = []) {}

  async emit(repo: string, events: readonly RefEvent[], defaultBranch?: string): Promise<void> {
    if (this.failFor.has(repo)) {
      throw new Error('PutEvents failed');
    }
    this.journal.push(`emit:${repo}:${events.map((e) => `${e.kind} ${e.ref}`).join(',')}`);
    this.emitted.push({ repo, events, defaultBranch });
  }
}

interface Harness {
  deps: PollerDeps;
  store: FakeStore;
  config: FakeConfig;
  emitter: FakeEmitter;
  journal: Journal;
  metrics: TickMetrics[];
  transportCalls: { repo: string; hostKeyPins: readonly Buffer[] }[];
  clock: { now: number };
}

function harness(options: {
  repos: string[];
  transport: (repo: string) => LsRefsResult | Promise<LsRefsResult>;
  meta?: GithubMeta;
}): Harness {
  const journal: Journal = [];
  const store = new FakeStore(journal);
  const config = new FakeConfig(
    options.repos,
    new Map(options.repos.map((repo) => [repo, `KEY-${repo}`])),
  );
  const emitter = new FakeEmitter(journal);
  const metrics: TickMetrics[] = [];
  const transportCalls: Harness['transportCalls'] = [];
  const clock = { now: NOW };
  const deps: PollerDeps = {
    store,
    config,
    emitter,
    transport: async ({ repo, hostKeyPins }) => {
      transportCalls.push({ repo, hostKeyPins });
      return options.transport(repo);
    },
    fetchMeta: async () => options.meta ?? { ssh_keys: [...COMPILED_IN_HOST_KEYS] },
    metrics: (m) => metrics.push(m),
    log: () => {},
    now: () => clock.now,
    cadenceMs: CADENCE,
    concurrency: 8,
  };
  return { deps, store, config, emitter, journal, metrics, transportCalls, clock };
}

describe('runTick — diff, emit-then-commit', () => {
  it('emits push/branch/tag diffs with defaultBranch, then commits the map', async () => {
    const h = harness({
      repos: ['octo/app'],
      transport: () =>
        advertisement({
          'refs/heads/main': sha(10),
          'refs/heads/feature': sha(11),
          'refs/tags/v2': sha(12),
        }),
    });
    h.store.refMaps.set('octo/app', {
      map: { 'refs/heads/main': sha(1), 'refs/tags/v1': sha(2) },
      defaultBranch: 'main',
    });

    const summary = await runTick(h.deps);

    expect(summary.outcomes).toEqual([{ repo: 'octo/app', status: 'ok', eventsEmitted: 3 }]);
    expect(h.emitter.emitted[0].defaultBranch).toBe('main');
    expect(h.emitter.emitted[0].events).toEqual([
      { kind: 'branch', ref: 'refs/heads/feature', sha: sha(11) },
      { kind: 'push', ref: 'refs/heads/main', sha: sha(10) },
      { kind: 'tag', ref: 'refs/tags/v2', sha: sha(12) },
    ]);
    // The pinned ordering: emit strictly before commit.
    expect(h.journal).toEqual([
      'emit:octo/app:branch refs/heads/feature,push refs/heads/main,tag refs/tags/v2',
      'commit:octo/app',
    ]);
    // v1 (deleted) is gone from the committed map; no event kind exists for it.
    expect(Object.keys(h.store.refMaps.get('octo/app')!.map).sort()).toEqual([
      'refs/heads/feature',
      'refs/heads/main',
      'refs/tags/v2',
    ]);
  });

  it('commits a baseline without emitting on a repo\'s first poll', async () => {
    const h = harness({
      repos: ['octo/app'],
      transport: () => advertisement({ 'refs/heads/main': sha(1) }),
    });
    const summary = await runTick(h.deps);
    expect(summary.outcomes[0].status).toBe('baseline');
    expect(h.emitter.emitted).toEqual([]);
    expect(h.store.refMaps.get('octo/app')).toBeDefined();
  });

  it('does NOT commit when emission fails, so the next tick re-emits (no drop)', async () => {
    const h = harness({
      repos: ['octo/app'],
      transport: () => advertisement({ 'refs/heads/main': sha(10) }),
    });
    h.store.refMaps.set('octo/app', { map: { 'refs/heads/main': sha(1) } });
    h.emitter.failFor.add('octo/app');

    const failed = await runTick(h.deps);
    expect(failed.outcomes[0].status).toBe('emit-failed');
    expect(h.store.refMaps.get('octo/app')!.map['refs/heads/main']).toBe(sha(1));
    expect(h.journal).toEqual([]);

    // The crash-window replay: the same diff is emitted again once emission
    // recovers, and only then is the map committed.
    h.emitter.failFor.clear();
    h.clock.now += CADENCE;
    const recovered = await runTick(h.deps);
    expect(recovered.outcomes[0].status).toBe('ok');
    expect(h.journal).toEqual([
      'emit:octo/app:push refs/heads/main',
      'commit:octo/app',
    ]);
  });

  it('touches nothing when the refs are unchanged', async () => {
    const h = harness({
      repos: ['octo/app'],
      transport: () => advertisement({ 'refs/heads/main': sha(1) }),
    });
    h.store.refMaps.set('octo/app', {
      map: { 'refs/heads/main': sha(1) },
      defaultBranch: 'main',
    });
    const summary = await runTick(h.deps);
    expect(summary.outcomes[0].status).toBe('unchanged');
    expect(h.journal).toEqual([]);
  });

  it('commits deletions without emitting (no event kind exists for them)', async () => {
    const h = harness({
      repos: ['octo/app'],
      transport: () => advertisement({ 'refs/heads/main': sha(1) }),
    });
    h.store.refMaps.set('octo/app', {
      map: { 'refs/heads/main': sha(1), 'refs/heads/gone': sha(2) },
      defaultBranch: 'main',
    });
    const summary = await runTick(h.deps);
    expect(summary.outcomes[0].status).toBe('ok');
    expect(h.journal).toEqual(['commit:octo/app']);
  });
});

describe('runTick — quarantine (spec §6.3)', () => {
  it('quarantines on upload-pack refusal and skips until the retry window', async () => {
    let found = false;
    const h = harness({
      repos: ['octo/gone'],
      transport: () => {
        if (!found) {
          throw new UploadPackRefusedError('Repository not found.');
        }
        return advertisement({ 'refs/heads/main': sha(1) });
      },
    });

    const first = await runTick(h.deps);
    expect(first.outcomes[0].status).toBe('quarantined');
    expect(h.config.evicted).toEqual(['octo/gone']);
    expect(h.store.quarantines.get('octo/gone')?.reason).toBe('Repository not found.');

    // Inside the retry window: not polled at all.
    h.clock.now += CADENCE;
    const skipped = await runTick(h.deps);
    expect(skipped.outcomes[0].status).toBe('quarantine-skipped');
    expect(h.transportCalls).toHaveLength(1);

    // Window open, repo restored: polled again and the marker is lifted.
    found = true;
    h.clock.now += QUARANTINE_BASE_RETRY_MS;
    const recovered = await runTick(h.deps);
    expect(recovered.outcomes[0].status).toBe('baseline');
    expect(h.store.quarantines.has('octo/gone')).toBe(false);
  });

  it('quarantines on deploy-key auth rejection', async () => {
    const h = harness({
      repos: ['octo/app'],
      transport: () => {
        throw new SshAuthRejectedError('octo/app: deploy key rejected');
      },
    });
    const summary = await runTick(h.deps);
    expect(summary.outcomes[0].status).toBe('quarantined');
  });

  it('quarantines a repo whose deploy-key parameter is missing', async () => {
    const h = harness({
      repos: ['octo/app'],
      transport: () => advertisement({ 'refs/heads/main': sha(1) }),
    });
    h.config.deployKeys.delete('octo/app');
    const summary = await runTick(h.deps);
    expect(summary.outcomes[0].status).toBe('quarantined');
    expect(h.transportCalls).toHaveLength(0);
  });
});

describe('runTick — circuit breaker (spec §6.3)', () => {
  const failingRepos = ['octo/a', 'octo/b', 'octo/c', 'octo/d'];

  it('opens on quorum transport failure, holds, probes, and recovers', async () => {
    let up = false;
    const h = harness({
      repos: failingRepos,
      transport: (repo) => {
        if (!up) {
          throw new Error(`connect ETIMEDOUT ${repo}`);
        }
        return advertisement({ 'refs/heads/main': sha(1) });
      },
    });

    const opening = await runTick(h.deps);
    expect(opening.breaker.state).toBe('open');
    expect(h.metrics[0].TransportFailures).toBe(4);
    expect(h.metrics[0].CircuitBreakerOpen).toBe(1);

    // Before the probe is due: a hold tick, no SSH at all.
    const callsSoFar = h.transportCalls.length;
    const holding = await runTick(h.deps);
    expect(holding.plan).toBe('hold');
    expect(h.transportCalls).toHaveLength(callsSoFar);

    // Probe due, transport still down: stays open, probe schedule decays.
    h.clock.now += CADENCE;
    const failedProbe = await runTick(h.deps);
    expect(failedProbe.plan).toBe('probe');
    expect(h.transportCalls).toHaveLength(callsSoFar + 1);
    expect(failedProbe.breaker.state).toBe('open');
    expect(failedProbe.breaker.nextProbeAt).toBe(h.clock.now + 2 * CADENCE);

    // Transport back: the next due probe closes the breaker.
    up = true;
    h.clock.now += 2 * CADENCE;
    const recovered = await runTick(h.deps);
    expect(recovered.plan).toBe('probe');
    expect(recovered.breaker).toEqual(CLOSED_BREAKER);

    // And the following tick is a full fan-out again.
    h.clock.now += CADENCE;
    const full = await runTick(h.deps);
    expect(full.plan).toBe('full');
    expect(full.outcomes).toHaveLength(4);
  });

  it('a per-repo refusal counts as probe success — transport is healthy', async () => {
    const h = harness({
      repos: ['octo/gone'],
      transport: () => {
        throw new UploadPackRefusedError('Repository not found.');
      },
    });
    h.store.breaker = {
      state: 'open',
      openedAt: new Date(NOW - CADENCE).toISOString(),
      probeAttempts: 0,
      nextProbeAt: NOW,
    };
    const summary = await runTick(h.deps);
    expect(summary.plan).toBe('probe');
    expect(summary.breaker).toEqual(CLOSED_BREAKER);
  });

  it('stays closed below quorum', async () => {
    let calls = 0;
    const h = harness({
      repos: failingRepos,
      transport: (repo) => {
        calls += 1;
        if (repo === 'octo/a' || repo === 'octo/b') {
          throw new Error('ECONNREFUSED');
        }
        return advertisement({ 'refs/heads/main': sha(1) });
      },
    });
    const summary = await runTick(h.deps);
    expect(calls).toBe(4);
    expect(summary.breaker).toEqual(CLOSED_BREAKER);
    expect(h.store.breakerWrites).toEqual([]);
  });
});

describe('runTick — host keys (spec §6.1)', () => {
  const rotatedKey = Buffer.from('brand-new-github-host-key');
  const rotatedLine = `ssh-ed25519 ${rotatedKey.toString('base64')}`;

  it('auto-reconciles a confirmed rotation, retries, and flags the metric', async () => {
    let attempts = 0;
    const h = harness({
      repos: ['octo/app'],
      transport: () => {
        attempts += 1;
        if (attempts === 1) {
          throw new HostKeyMismatchError('unpinned key', rotatedKey);
        }
        return advertisement({ 'refs/heads/main': sha(1) });
      },
      meta: { ssh_keys: [...COMPILED_IN_HOST_KEYS, rotatedLine] },
    });

    const summary = await runTick(h.deps);
    expect(summary.outcomes[0].status).toBe('baseline');
    expect(attempts).toBe(2);
    // The reconciled key set is persisted for later ticks…
    expect(h.store.reconciledKeys).toContain(rotatedLine);
    // …and the retry already carried the rotated pin.
    const retryPins = h.transportCalls[1].hostKeyPins;
    expect(retryPins.some((pin) => pin.equals(rotatedKey))).toBe(true);
    expect(h.metrics[0].HostKeyRotationReconciled).toBe(1);

    // Next tick trusts the reconciled pin from the store without re-fetching /meta.
    h.clock.now += CADENCE;
    await runTick(h.deps);
    expect(h.transportCalls[2].hostKeyPins.some((pin) => pin.equals(rotatedKey))).toBe(true);
  });

  it('hard-fails the repo poll when /meta does not confirm the rotation', async () => {
    const h = harness({
      repos: ['octo/app'],
      transport: () => {
        throw new HostKeyMismatchError('unpinned key', rotatedKey);
      },
      meta: { ssh_keys: [...COMPILED_IN_HOST_KEYS] },
    });
    const summary = await runTick(h.deps);
    expect(summary.outcomes[0].status).toBe('host-key-failed');
    expect(h.store.reconciledKeys).toBeUndefined();
    expect(h.store.quarantines.size).toBe(0);
    expect(h.metrics[0].HostKeyHardFailures).toBe(1);
    expect(h.metrics[0].HostKeyRotationReconciled).toBe(0);
  });

  it('polls with the compiled-in pins before setup seeds the SSM parameter', async () => {
    const h = harness({
      repos: ['octo/app'],
      transport: () => advertisement({ 'refs/heads/main': sha(1) }),
    });
    await runTick(h.deps);
    const expected = parseHostKeyPins(COMPILED_IN_HOST_KEYS.join('\n'));
    expect(h.transportCalls[0].hostKeyPins.map((pin) => pin.toString('base64'))).toEqual(
      expected.map((pin) => pin.toString('base64')),
    );
  });
});

describe('mapWithConcurrency', () => {
  it('never exceeds the bound and preserves order', async () => {
    let inFlight = 0;
    let peak = 0;
    const items = Array.from({ length: 20 }, (_, i) => i);
    const results = await mapWithConcurrency(items, 8, async (item) => {
      inFlight += 1;
      peak = Math.max(peak, inFlight);
      await new Promise((resolve) => setTimeout(resolve, 1));
      inFlight -= 1;
      return item * 2;
    });
    expect(peak).toBeLessThanOrEqual(8);
    expect(results).toEqual(items.map((i) => i * 2));
  });
});
