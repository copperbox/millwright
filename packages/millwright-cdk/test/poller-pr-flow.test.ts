import { describe, expect, it } from 'vitest';
import { MAX_PR_BACKOFF_MS } from '../src/runtime/poller/degradation';
import { GithubApiError, TokenMinter } from '../src/runtime/poller/github-app';
import { PrTickMetrics } from '../src/runtime/poller/metrics';
import { BusEmitter, BusEvent } from '../src/runtime/poller/poller';
import {
  PrConfigPlane,
  PrPollerDeps,
  PrPollingStore,
  PrSnapshot,
  PullsFetcher,
  PullsResult,
  createPullsFetcher,
  runPrTick,
} from '../src/runtime/poller/pr-poll';

const NOW = 1_760_000_000_000;
const CADENCE = 60_000;
const sha = (seed: number) => seed.toString(16).padStart(40, '0');

type Journal = string[];

class FakePrStore implements PrPollingStore {
  snapshots = new Map<string, PrSnapshot>();

  constructor(private readonly journal: Journal = []) {}

  async getPrSnapshot(repo: string): Promise<PrSnapshot | undefined> {
    return this.snapshots.get(repo);
  }
  async putPrSnapshot(repo: string, snapshot: PrSnapshot): Promise<void> {
    this.journal.push(`commit:${repo}`);
    this.snapshots.set(repo, snapshot);
  }
}

class FakePrConfig implements PrConfigPlane {
  configs = new Map<string, { prPolling: boolean; forkPrPolicy: boolean }>();

  constructor(public repos: string[]) {}

  async listRepos(): Promise<string[]> {
    return [...this.repos];
  }
  getRepoConfig(repo: string): { prPolling: boolean; forkPrPolicy: boolean } {
    return this.configs.get(repo) ?? { prPolling: true, forkPrPolicy: false };
  }
}

class FakeEmitter implements BusEmitter {
  emitted: { repo: string; events: readonly BusEvent[]; defaultBranch?: string }[] = [];
  failFor = new Set<string>();

  constructor(private readonly journal: Journal = []) {}

  async emit(repo: string, events: readonly BusEvent[], defaultBranch?: string): Promise<void> {
    if (this.failFor.has(repo)) {
      throw new Error('PutEvents failed');
    }
    this.journal.push(`emit:${repo}:${events.map((e) => `${e.ref}@${e.sha.slice(-2)}`).join(',')}`);
    this.emitted.push({ repo, events, defaultBranch });
  }
}

const alwaysMinter: TokenMinter = {
  configured: async () => true,
  tokenFor: async () => 'ghs_test',
};

interface PullSpec {
  number: number;
  headSha: string;
  open?: boolean;
  headRepo?: string | null;
}

/** A 200 listing for the repo (most-recently-updated ordering is the caller's). */
function listing(repo: string, pulls: PullSpec[], etag = 'W/"e1"'): PullsResult {
  return {
    status: 'ok',
    etag,
    pulls: pulls.map((p) => ({
      number: p.number,
      open: p.open ?? true,
      headSha: p.headSha,
      ...(p.headRepo === null ? {} : { headRepo: p.headRepo ?? repo }),
      baseDefaultBranch: 'main',
    })),
  };
}

interface Harness {
  deps: PrPollerDeps;
  store: FakePrStore;
  config: FakePrConfig;
  emitter: FakeEmitter;
  journal: Journal;
  metrics: PrTickMetrics[];
  fetchCalls: { repo: string; etag?: string }[];
  clock: { now: number };
  logs: string[];
}

function harness(options: {
  repos: string[];
  pulls: (repo: string, etag?: string) => PullsResult;
  minter?: TokenMinter;
}): Harness {
  const journal: Journal = [];
  const store = new FakePrStore(journal);
  const config = new FakePrConfig(options.repos);
  const emitter = new FakeEmitter(journal);
  const metrics: PrTickMetrics[] = [];
  const fetchCalls: Harness['fetchCalls'] = [];
  const clock = { now: NOW };
  const logs: string[] = [];
  const fetchPulls: PullsFetcher = async ({ repo, etag }) => {
    fetchCalls.push({ repo, etag });
    return options.pulls(repo, etag);
  };
  const deps: PrPollerDeps = {
    store,
    config,
    emitter,
    fetchPulls,
    minter: options.minter ?? alwaysMinter,
    metrics: (m) => metrics.push(m),
    log: (message) => logs.push(message),
    now: () => clock.now,
    random: () => 0.5,
    cadenceMs: CADENCE,
    concurrency: 8,
  };
  return { deps, store, config, emitter, journal, metrics, fetchCalls, clock, logs };
}

describe('runPrTick — diff, emit-then-commit (spec §6.2)', () => {
  it('emits pr events for new and moved heads, then commits the snapshot', async () => {
    const h = harness({
      repos: ['octo/app'],
      pulls: (repo) =>
        listing(repo, [
          { number: 7, headSha: sha(21) },
          { number: 3, headSha: sha(22) },
          { number: 2, headSha: sha(2), open: false },
        ]),
    });
    h.store.snapshots.set('octo/app', {
      etag: 'W/"e0"',
      heads: { '3': sha(12), '2': sha(2) },
      forkPrPolicy: false,
    });

    const summary = await runPrTick(h.deps);

    expect(summary.enabled).toBe(true);
    expect(summary.outcomes).toEqual([
      { repo: 'octo/app', status: 'ok', eventsEmitted: 2, forkEventsDropped: 0 },
    ]);
    // The event carries the PR ref and HEAD sha — never a branch name.
    expect(h.emitter.emitted[0].events).toEqual([
      { kind: 'pr', ref: 'refs/pull/3/head', sha: sha(22) },
      { kind: 'pr', ref: 'refs/pull/7/head', sha: sha(21) },
    ]);
    expect(h.emitter.emitted[0].defaultBranch).toBe('main');
    // Emit strictly before commit, and the conditional request used the ETag.
    expect(h.journal).toEqual([
      'emit:octo/app:refs/pull/3/head@16,refs/pull/7/head@15',
      'commit:octo/app',
    ]);
    expect(h.fetchCalls).toEqual([{ repo: 'octo/app', etag: 'W/"e0"' }]);
    // Closed #2 left the heads; the new listing's ETag was committed.
    expect(h.store.snapshots.get('octo/app')).toEqual({
      etag: 'W/"e1"',
      heads: { '3': sha(22), '7': sha(21) },
      forkPrPolicy: false,
    });
    expect(h.metrics[0].PrEventsEmitted).toBe(2);
    expect(h.metrics[0].PrReposPolled).toBe(1);
  });

  it('commits a baseline without emitting on a repo\'s first listing', async () => {
    const h = harness({
      repos: ['octo/app'],
      pulls: (repo) => listing(repo, [{ number: 1, headSha: sha(1) }]),
    });
    const summary = await runPrTick(h.deps);
    expect(summary.outcomes[0].status).toBe('baseline');
    expect(h.emitter.emitted).toEqual([]);
    expect(h.store.snapshots.get('octo/app')?.heads).toEqual({ '1': sha(1) });
  });

  it('an unchanged listing costs a 304 and touches nothing', async () => {
    const h = harness({
      repos: ['octo/app'],
      pulls: () => ({ status: 'not-modified' }),
    });
    h.store.snapshots.set('octo/app', { etag: 'W/"e0"', heads: {}, forkPrPolicy: false });
    const summary = await runPrTick(h.deps);
    expect(summary.outcomes[0].status).toBe('not-modified');
    expect(h.journal).toEqual([]);
    expect(h.metrics[0].PrNotModified).toBe(1);
  });

  it('does NOT commit when emission fails, so the next tick re-emits', async () => {
    const h = harness({
      repos: ['octo/app'],
      pulls: (repo) => listing(repo, [{ number: 5, headSha: sha(9) }]),
    });
    h.store.snapshots.set('octo/app', { etag: 'W/"e0"', heads: {}, forkPrPolicy: false });
    h.emitter.failFor.add('octo/app');

    const failed = await runPrTick(h.deps);
    expect(failed.outcomes[0].status).toBe('emit-failed');
    expect(h.store.snapshots.get('octo/app')!.etag).toBe('W/"e0"');
    expect(h.journal).toEqual([]);

    h.emitter.failFor.clear();
    h.clock.now += CADENCE;
    const recovered = await runPrTick(h.deps);
    expect(recovered.outcomes[0].status).toBe('ok');
    expect(h.journal).toEqual([`emit:octo/app:refs/pull/5/head@${sha(9).slice(-2)}`, 'commit:octo/app']);
  });

  it('skips repos whose prPolling toggle is off without any request', async () => {
    const h = harness({
      repos: ['octo/app', 'octo/quiet'],
      pulls: (repo) => listing(repo, [{ number: 1, headSha: sha(1) }]),
    });
    h.config.configs.set('octo/quiet', { prPolling: false, forkPrPolicy: false });
    const summary = await runPrTick(h.deps);
    expect(summary.outcomes.map((o) => `${o.repo}:${o.status}`)).toEqual([
      'octo/app:baseline',
      'octo/quiet:disabled',
    ]);
    expect(h.fetchCalls.map((c) => c.repo)).toEqual(['octo/app']);
  });

  it('stays idle without the github/app parameter', async () => {
    const h = harness({
      repos: ['octo/app'],
      pulls: (repo) => listing(repo, [{ number: 1, headSha: sha(1) }]),
      minter: { configured: async () => false, tokenFor: async () => 'unreachable' },
    });
    const summary = await runPrTick(h.deps);
    expect(summary.enabled).toBe(false);
    expect(h.fetchCalls).toEqual([]);
    expect(h.metrics).toEqual([]);
  });
});

describe('runPrTick — fork PRs (spec §13.1a)', () => {
  const forkPulls = (repo: string) =>
    listing(repo, [
      { number: 8, headSha: sha(31), headRepo: 'stranger/app' },
      { number: 9, headSha: sha(32) },
    ]);

  it('drops fork-authored PR events with a log line when forkPrPolicy is off', async () => {
    const h = harness({ repos: ['octo/app'], pulls: forkPulls });
    h.store.snapshots.set('octo/app', { etag: 'W/"e0"', heads: {}, forkPrPolicy: false });

    const summary = await runPrTick(h.deps);
    expect(summary.outcomes[0]).toEqual({
      repo: 'octo/app',
      status: 'ok',
      eventsEmitted: 1,
      forkEventsDropped: 1,
    });
    expect(h.emitter.emitted[0].events).toEqual([
      { kind: 'pr', ref: 'refs/pull/9/head', sha: sha(32) },
    ]);
    expect(h.logs.some((line) => line.includes('fork-authored PR event dropped'))).toBe(true);
    // The dropped head stays out of the snapshot so opting in emits it later.
    expect(h.store.snapshots.get('octo/app')!.heads).toEqual({ '9': sha(32) });
    expect(h.metrics[0].PrForkEventsDropped).toBe(1);
  });

  it('lets fork PRs flow when the repo opts in', async () => {
    const h = harness({ repos: ['octo/app'], pulls: forkPulls });
    h.config.configs.set('octo/app', { prPolling: true, forkPrPolicy: true });
    h.store.snapshots.set('octo/app', { etag: 'W/"e0"', heads: {}, forkPrPolicy: true });

    const summary = await runPrTick(h.deps);
    expect(summary.outcomes[0].eventsEmitted).toBe(2);
    expect(summary.outcomes[0].forkEventsDropped).toBe(0);
    expect(h.emitter.emitted[0].events.map((e) => e.ref)).toEqual([
      'refs/pull/8/head',
      'refs/pull/9/head',
    ]);
  });

  it('treats a deleted head fork as fork-authored', async () => {
    const h = harness({
      repos: ['octo/app'],
      pulls: (repo) => listing(repo, [{ number: 4, headSha: sha(4), headRepo: null }]),
    });
    h.store.snapshots.set('octo/app', { etag: 'W/"e0"', heads: {}, forkPrPolicy: false });
    const summary = await runPrTick(h.deps);
    expect(summary.outcomes[0].forkEventsDropped).toBe(1);
    expect(h.emitter.emitted).toEqual([]);
  });

  it('an off→on policy flip forces a full re-listing past the ETag', async () => {
    const h = harness({ repos: ['octo/app'], pulls: forkPulls });
    h.store.snapshots.set('octo/app', {
      etag: 'W/"e0"',
      heads: { '9': sha(32) },
      forkPrPolicy: false,
    });
    h.config.configs.set('octo/app', { prPolling: true, forkPrPolicy: true });

    const summary = await runPrTick(h.deps);
    // No If-None-Match on the flip: the withheld fork PR re-surfaces and flows.
    expect(h.fetchCalls).toEqual([{ repo: 'octo/app', etag: undefined }]);
    expect(summary.outcomes[0].eventsEmitted).toBe(1);
    expect(h.emitter.emitted[0].events).toEqual([
      { kind: 'pr', ref: 'refs/pull/8/head', sha: sha(31) },
    ]);
    expect(h.store.snapshots.get('octo/app')!.forkPrPolicy).toBe(true);
  });
});

describe('runPrTick — degradation (spec §6.3)', () => {
  it('backs off with jitter on API errors and recovers', async () => {
    let down = true;
    const h = harness({
      repos: ['octo/app'],
      pulls: (repo) => {
        if (down) {
          throw new GithubApiError('GET pulls returned 502', 502);
        }
        return listing(repo, [{ number: 1, headSha: sha(1) }]);
      },
    });
    h.store.snapshots.set('octo/app', { etag: 'W/"e0"', heads: {}, forkPrPolicy: false });

    const first = await runPrTick(h.deps);
    expect(first.outcomes[0].status).toBe('api-error');
    const backoff = h.store.snapshots.get('octo/app')!.backoff!;
    expect(backoff.attempts).toBe(1);
    // Equal jitter at random()=0.5: cadence/2 + 0.5 * cadence/2.
    expect(backoff.retryAt).toBe(NOW + CADENCE * 0.75);
    expect(h.metrics[0].PrApiErrors).toBe(1);

    // Inside the window: skipped, no request.
    h.clock.now += CADENCE / 2;
    const skipped = await runPrTick(h.deps);
    expect(skipped.outcomes[0].status).toBe('backoff-skipped');
    expect(h.fetchCalls).toHaveLength(1);
    expect(h.metrics[1].PrBackoffSkips).toBe(1);

    // Still down at the retry: attempts decay the window exponentially.
    h.clock.now = backoff.retryAt + 1;
    await runPrTick(h.deps);
    expect(h.store.snapshots.get('octo/app')!.backoff!.attempts).toBe(2);

    // Recovery clears the backoff and polling resumes.
    down = false;
    h.clock.now += MAX_PR_BACKOFF_MS;
    const recovered = await runPrTick(h.deps);
    expect(recovered.outcomes[0].status).toBe('ok');
    expect(h.store.snapshots.get('octo/app')!.backoff).toBeUndefined();
  });

  it('clears a stale backoff on a 304 without disturbing the snapshot', async () => {
    const h = harness({ repos: ['octo/app'], pulls: () => ({ status: 'not-modified' }) });
    h.store.snapshots.set('octo/app', {
      etag: 'W/"e0"',
      heads: { '1': sha(1) },
      forkPrPolicy: false,
      backoff: { attempts: 3, retryAt: NOW - 1 },
    });
    const summary = await runPrTick(h.deps);
    expect(summary.outcomes[0].status).toBe('not-modified');
    const snapshot = h.store.snapshots.get('octo/app')!;
    expect(snapshot.backoff).toBeUndefined();
    expect(snapshot.etag).toBe('W/"e0"');
    expect(snapshot.heads).toEqual({ '1': sha(1) });
  });

  it('floors the retry at a rate-limit reset when GitHub announces one', async () => {
    const resetMs = NOW + 20 * 60 * 1000;
    const h = harness({
      repos: ['octo/app'],
      pulls: () => {
        throw new GithubApiError('GET pulls returned 403', 403, resetMs);
      },
    });
    h.store.snapshots.set('octo/app', { etag: 'W/"e0"', heads: {}, forkPrPolicy: false });
    await runPrTick(h.deps);
    const backoff = h.store.snapshots.get('octo/app')!.backoff!;
    expect(backoff.retryAt).toBeGreaterThanOrEqual(resetMs);
  });

  it('a token-minting failure backs the repo off like any API error', async () => {
    const h = harness({
      repos: ['octo/app'],
      pulls: (repo) => listing(repo, [{ number: 1, headSha: sha(1) }]),
      minter: {
        configured: async () => true,
        tokenFor: async () => {
          throw new GithubApiError('POST access_tokens returned 500', 500);
        },
      },
    });
    const summary = await runPrTick(h.deps);
    expect(summary.outcomes[0].status).toBe('api-error');
    expect(h.fetchCalls).toEqual([]);
    expect(h.store.snapshots.get('octo/app')!.backoff!.attempts).toBe(1);
  });

  it('one repo\'s failure never touches the others', async () => {
    const h = harness({
      repos: ['octo/bad', 'octo/good'],
      pulls: (repo) => {
        if (repo === 'octo/bad') {
          throw new GithubApiError('boom', 500);
        }
        return listing(repo, [{ number: 1, headSha: sha(1) }]);
      },
    });
    h.store.snapshots.set('octo/good', { heads: {}, forkPrPolicy: false });
    const summary = await runPrTick(h.deps);
    expect(summary.outcomes.map((o) => o.status)).toEqual(['api-error', 'ok']);
    expect(summary.eventsEmitted).toBe(1);
  });
});

describe('createPullsFetcher — the pinned tier-2 query (spec §6.2)', () => {
  const pull = {
    number: 12,
    state: 'open',
    head: { sha: sha(5).toUpperCase(), repo: { full_name: 'octo/app' } },
    base: { repo: { default_branch: 'main' } },
  };

  it('requests state=all sort=updated with the ETag and parses the page', async () => {
    let captured: { url: string; headers: Record<string, string> } | undefined;
    const fetcher = createPullsFetcher(async (url, init) => {
      captured = { url, headers: init.headers as Record<string, string> };
      return Response.json([pull, { unparseable: true }], {
        status: 200,
        headers: { etag: 'W/"fresh"' },
      });
    }, 'https://api.github.example');

    const result = await fetcher({ repo: 'octo/app', token: 'ghs_x', etag: 'W/"old"' });
    expect(captured!.url).toBe(
      'https://api.github.example/repos/octo/app/pulls?state=all&sort=updated&direction=desc&per_page=100',
    );
    expect(captured!.headers.authorization).toBe('Bearer ghs_x');
    expect(captured!.headers['if-none-match']).toBe('W/"old"');
    expect(result).toEqual({
      status: 'ok',
      etag: 'W/"fresh"',
      pulls: [
        {
          number: 12,
          open: true,
          headSha: sha(5),
          headRepo: 'octo/app',
          baseDefaultBranch: 'main',
        },
      ],
    });
  });

  it('maps 304 to not-modified and other statuses to GithubApiError', async () => {
    const fetcher304 = createPullsFetcher(async () => new Response(null, { status: 304 }));
    expect(await fetcher304({ repo: 'o/r', token: 't' })).toEqual({ status: 'not-modified' });

    const fetcher403 = createPullsFetcher(async () =>
      Response.json(
        { message: 'rate limited' },
        {
          status: 403,
          headers: { 'x-ratelimit-remaining': '0', 'x-ratelimit-reset': '1760000900' },
        },
      ),
    );
    const err = (await fetcher403({ repo: 'o/r', token: 't' }).catch((e) => e)) as GithubApiError;
    expect(err).toBeInstanceOf(GithubApiError);
    expect(err.status).toBe(403);
    expect(err.rateLimitResetMs).toBe(1_760_000_900_000);
  });

  it('wraps network failures and non-array bodies', async () => {
    const fetcherDown = createPullsFetcher(async () => {
      throw new Error('ECONNRESET');
    });
    await expect(fetcherDown({ repo: 'o/r', token: 't' })).rejects.toBeInstanceOf(GithubApiError);

    const fetcherOdd = createPullsFetcher(async () => Response.json({ message: 'hi' }));
    await expect(fetcherOdd({ repo: 'o/r', token: 't' })).rejects.toBeInstanceOf(GithubApiError);
  });
});
