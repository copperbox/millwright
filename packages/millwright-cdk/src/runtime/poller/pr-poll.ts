import { PR_REF_PREFIX, RepoPollingConfig } from '@copperbox/millwright-state';
import { GithubApiError, HttpFetch, TokenMinter, rateLimitResetMs } from './github-app';
import { PrBackoffState, isPrBackoffActive, prBackoff } from './degradation';
import { PrMetricsSink } from './metrics';
import { BusEmitter, Logger, mapWithConcurrency } from './poller';

/**
 * Tier 2 — PR polling (spec §6.2, §13.1a), one tick: list every enabled
 * repo's pulls (`state=all&sort=updated`, App-token authenticated, per-repo
 * ETag), diff head shas against the polling table's snapshot, emit `pr`
 * events, THEN commit the snapshot — the same emit-then-commit ordering as
 * tier 1, absorbed by the launcher's dedupe on a crash-window re-emit.
 *
 * Explicitly best-effort: it rides the tier-1 tick's cadence (the 60–120 s
 * band at the default 1-min `pollCadence`), degrades when the REST API
 * degrades (per-repo backoff with jitter, spec §6.3), and never touches
 * tier-1 state. Events carry the PR ref (`refs/pull/N/head`) and the HEAD
 * sha, never the merge sha or the fork's branch name — and fork-authored PRs
 * are dropped unless the repo's `forkPrPolicy` opts in.
 */

/** The polling table's per-repo PR item (spec §9.4, `PR-ETAG` sort key). */
export interface PrSnapshot {
  /** ETag of the last 200 pulls listing; absent until one succeeds. */
  readonly etag?: string;
  /** Open PR number → last-committed head sha. */
  readonly heads: Readonly<Record<string, string>>;
  /**
   * `forkPrPolicy` at commit time: an off→on flip invalidates the ETag so
   * fork PRs dropped under the old policy re-surface without waiting for the
   * listing to change again.
   */
  readonly forkPrPolicy: boolean;
  readonly backoff?: PrBackoffState;
}

/** PR-snapshot access; `store.ts` provides the DynamoDB implementation. */
export interface PrPollingStore {
  getPrSnapshot(repo: string): Promise<PrSnapshot | undefined>;
  putPrSnapshot(repo: string, snapshot: PrSnapshot, nowMs: number): Promise<void>;
}

/** Config-plane slice tier 2 needs; `config.ts` provides the implementation. */
export interface PrConfigPlane {
  listRepos(): Promise<string[]>;
  /** Parsed polling toggles of the repo's config parameter. */
  getRepoConfig(repo: string): RepoPollingConfig;
}

/** One PR from the pulls listing, reduced to what tier 2 needs. */
export interface PullSummary {
  readonly number: number;
  readonly open: boolean;
  /** The PR's HEAD sha — never the merge sha (spec §13.1a). */
  readonly headSha: string;
  /** Head repo `owner/name`; undefined when the fork was deleted. */
  readonly headRepo?: string;
  /** The base repo's default branch, riding the same payload. */
  readonly baseDefaultBranch?: string;
}

export type PullsResult =
  | { readonly status: 'ok'; readonly etag?: string; readonly pulls: readonly PullSummary[] }
  | { readonly status: 'not-modified' };

/** One conditional pulls listing; throws GithubApiError on anything else. */
export type PullsFetcher = (options: {
  readonly repo: string;
  readonly token: string;
  readonly etag?: string;
}) => Promise<PullsResult>;

export interface PrEvent {
  readonly kind: 'pr';
  /** `refs/pull/<number>/head` — runs key off this, never a branch name. */
  readonly ref: string;
  readonly sha: string;
}

export interface PrPollerDeps {
  readonly store: PrPollingStore;
  readonly config: PrConfigPlane;
  readonly emitter: BusEmitter;
  readonly fetchPulls: PullsFetcher;
  readonly minter: TokenMinter;
  readonly metrics: PrMetricsSink;
  readonly log: Logger;
  readonly now: () => number;
  /** Jitter source for backoff windows. */
  readonly random: () => number;
  /** The deployment's `pollCadence`, the backoff decay base. */
  readonly cadenceMs: number;
  /** Intra-tick fan-out bound, shared with tier 1. */
  readonly concurrency: number;
}

export type PrRepoStatus =
  /** Diff events emitted (possibly zero) and the snapshot committed. */
  | 'ok'
  /** No stored snapshot yet — committed a baseline without emitting. */
  | 'baseline'
  /** Authenticated 304 — free against the primary rate limit. */
  | 'not-modified'
  /** The repo's `prPolling` toggle is off — not listed at all. */
  | 'disabled'
  /** Active tier-2 backoff — not listed this tick. */
  | 'backoff-skipped'
  /** Token mint or listing failed — backed off with jitter. */
  | 'api-error'
  /** Events could not all be emitted — snapshot NOT committed; next tick re-emits. */
  | 'emit-failed'
  /** Unexpected repo-local failure. */
  | 'error';

export interface PrRepoOutcome {
  readonly repo: string;
  readonly status: PrRepoStatus;
  readonly eventsEmitted: number;
  readonly forkEventsDropped: number;
  readonly error?: string;
}

export interface PrTickSummary {
  /** False when the github/app parameter is absent — tier 2 idle, no metrics. */
  readonly enabled: boolean;
  readonly outcomes: readonly PrRepoOutcome[];
  readonly eventsEmitted: number;
}

export async function runPrTick(deps: PrPollerDeps): Promise<PrTickSummary> {
  const startedAt = deps.now();
  if (!(await deps.minter.configured())) {
    deps.log('tier-2 PR polling idle — github/app parameter not configured');
    return { enabled: false, outcomes: [], eventsEmitted: 0 };
  }
  const repos = await deps.config.listRepos();
  const outcomes = await mapWithConcurrency(repos, deps.concurrency, (repo) =>
    pollRepoPrs(deps, repo),
  );
  const summary: PrTickSummary = {
    enabled: true,
    outcomes,
    eventsEmitted: outcomes.reduce((sum, o) => sum + o.eventsEmitted, 0),
  };
  const count = (status: PrRepoStatus) => outcomes.filter((o) => o.status === status).length;
  deps.metrics({
    PrTickDurationMs: deps.now() - startedAt,
    PrReposPolled: outcomes.length - count('disabled') - count('backoff-skipped'),
    PrEventsEmitted: summary.eventsEmitted,
    PrNotModified: count('not-modified'),
    PrApiErrors: count('api-error'),
    PrForkEventsDropped: outcomes.reduce((sum, o) => sum + o.forkEventsDropped, 0),
    PrBackoffSkips: count('backoff-skipped'),
  });
  deps.log('pr tick complete', {
    repos: repos.length,
    eventsEmitted: summary.eventsEmitted,
    notModified: count('not-modified'),
    apiErrors: count('api-error'),
    durationMs: deps.now() - startedAt,
  });
  return summary;
}

async function pollRepoPrs(deps: PrPollerDeps, repo: string): Promise<PrRepoOutcome> {
  const none = { eventsEmitted: 0, forkEventsDropped: 0 };
  try {
    const config = deps.config.getRepoConfig(repo);
    if (!config.prPolling) {
      return { repo, status: 'disabled', ...none };
    }
    const stored = await deps.store.getPrSnapshot(repo);
    if (isPrBackoffActive(stored?.backoff, deps.now())) {
      return { repo, status: 'backoff-skipped', ...none };
    }

    let result: PullsResult;
    try {
      const token = await deps.minter.tokenFor(repo);
      // An off→on fork-policy flip drops the ETag: the forced 200 re-lists
      // the fork PRs the old policy withheld from the committed heads.
      const policyFlippedOn = stored !== undefined && config.forkPrPolicy && !stored.forkPrPolicy;
      result = await deps.fetchPulls({
        repo,
        token,
        ...(policyFlippedOn || !stored?.etag ? {} : { etag: stored.etag }),
      });
    } catch (err) {
      return await backOff(deps, repo, stored, config, err);
    }

    if (result.status === 'not-modified') {
      if (stored?.backoff) {
        // First success after an episode: clear the backoff, keep the rest.
        await commit(deps, repo, { ...stored, backoff: undefined });
      }
      return { repo, status: 'not-modified', ...none };
    }

    const baseline = stored === undefined;
    const diff = diffPulls(deps, repo, stored?.heads ?? {}, result.pulls, config.forkPrPolicy);
    if (!baseline && diff.events.length > 0) {
      try {
        await deps.emitter.emit(repo, diff.events, diff.defaultBranch);
      } catch (err) {
        deps.log('pr event emission failed — snapshot NOT committed, next tick re-emits', {
          repo,
          error: (err as Error).message,
        });
        return { repo, status: 'emit-failed', ...none, error: (err as Error).message };
      }
    }
    await commit(deps, repo, {
      ...(result.etag ? { etag: result.etag } : {}),
      heads: diff.heads,
      forkPrPolicy: config.forkPrPolicy,
    });
    return {
      repo,
      status: baseline ? 'baseline' : 'ok',
      eventsEmitted: baseline ? 0 : diff.events.length,
      forkEventsDropped: diff.forkEventsDropped,
    };
  } catch (err) {
    deps.log('repo pr poll failed', { repo, error: (err as Error).message });
    return { repo, status: 'error', ...none, error: (err as Error).message };
  }
}

async function backOff(
  deps: PrPollerDeps,
  repo: string,
  stored: PrSnapshot | undefined,
  config: RepoPollingConfig,
  err: unknown,
): Promise<PrRepoOutcome> {
  const resetMs = err instanceof GithubApiError ? err.rateLimitResetMs : undefined;
  const backoff = prBackoff(stored?.backoff, deps.now(), deps.cadenceMs, deps.random, resetMs);
  await commit(deps, repo, {
    ...(stored ?? { heads: {}, forkPrPolicy: config.forkPrPolicy }),
    backoff,
  });
  deps.log('tier-2 API error — backing off with jitter', {
    repo,
    error: (err as Error).message,
    attempts: backoff.attempts,
    retryAt: new Date(backoff.retryAt).toISOString(),
  });
  return {
    repo,
    status: 'api-error',
    eventsEmitted: 0,
    forkEventsDropped: 0,
    error: (err as Error).message,
  };
}

function commit(deps: PrPollerDeps, repo: string, snapshot: PrSnapshot): Promise<void> {
  return deps.store.putPrSnapshot(repo, snapshot, deps.now());
}

interface PullsDiff {
  readonly events: PrEvent[];
  readonly heads: Record<string, string>;
  readonly forkEventsDropped: number;
  readonly defaultBranch?: string;
}

/**
 * Fold one pulls page (most-recently-updated first, one page — best-effort by
 * design) into the stored heads. Open PRs with a new head sha become events;
 * closed ones leave the map; fork-authored ones are dropped — and left OUT of
 * the committed heads, so opting in later emits them on the next listing.
 */
function diffPulls(
  deps: PrPollerDeps,
  repo: string,
  previousHeads: Readonly<Record<string, string>>,
  pulls: readonly PullSummary[],
  forkPrsAllowed: boolean,
): PullsDiff {
  const heads: Record<string, string> = { ...previousHeads };
  const events: { number: number; event: PrEvent }[] = [];
  const seen = new Set<number>();
  let forkEventsDropped = 0;
  let defaultBranch: string | undefined;
  for (const pull of pulls) {
    if (seen.has(pull.number)) {
      continue;
    }
    seen.add(pull.number);
    defaultBranch ??= pull.baseDefaultBranch;
    const key = String(pull.number);
    if (!pull.open) {
      delete heads[key];
      continue;
    }
    if (heads[key] === pull.headSha) {
      continue;
    }
    const fork =
      pull.headRepo === undefined || pull.headRepo.toLowerCase() !== repo.toLowerCase();
    if (fork && !forkPrsAllowed) {
      deps.log('fork-authored PR event dropped — forkPrPolicy is off for this repo', {
        repo,
        pr: pull.number,
        headSha: pull.headSha,
        headRepo: pull.headRepo,
      });
      forkEventsDropped += 1;
      delete heads[key];
      continue;
    }
    heads[key] = pull.headSha;
    events.push({
      number: pull.number,
      event: { kind: 'pr', ref: `${PR_REF_PREFIX}${pull.number}/head`, sha: pull.headSha },
    });
  }
  // Deterministic order so a crash-window re-emit is byte-identical.
  events.sort((a, b) => a.number - b.number);
  return {
    events: events.map((e) => e.event),
    heads,
    forkEventsDropped,
    ...(defaultBranch ? { defaultBranch } : {}),
  };
}

/**
 * The pinned tier-2 query (spec §6.2). One 100-entry page: anything past the
 * 100 most-recently-updated PRs inside one cadence is beyond best-effort.
 * Authenticated 304s don't count against the primary rate limit.
 */
export function createPullsFetcher(
  fetchImpl: HttpFetch,
  baseUrl = 'https://api.github.com',
): PullsFetcher {
  return async ({ repo, token, etag }) => {
    const path = `/repos/${repo}/pulls?state=all&sort=updated&direction=desc&per_page=100`;
    let response: Response;
    try {
      response = await fetchImpl(`${baseUrl}${path}`, {
        headers: {
          accept: 'application/vnd.github+json',
          authorization: `Bearer ${token}`,
          'user-agent': 'millwright-poller',
          ...(etag ? { 'if-none-match': etag } : {}),
        },
      });
    } catch (err) {
      throw new GithubApiError(`GET ${path}: ${(err as Error).message}`);
    }
    if (response.status === 304) {
      return { status: 'not-modified' };
    }
    if (response.status !== 200) {
      throw new GithubApiError(
        `GET ${path} returned ${response.status}`,
        response.status,
        rateLimitResetMs(response.headers),
      );
    }
    const body = (await response.json()) as unknown;
    if (!Array.isArray(body)) {
      throw new GithubApiError(`GET ${path} returned a non-array body`);
    }
    return {
      status: 'ok',
      etag: response.headers.get('etag') ?? undefined,
      pulls: body.flatMap((raw) => parsePull(raw) ?? []),
    };
  };
}

function parsePull(raw: unknown): PullSummary | undefined {
  const pull = raw as {
    number?: unknown;
    state?: unknown;
    head?: { sha?: unknown; repo?: { full_name?: unknown } | null };
    base?: { repo?: { default_branch?: unknown } | null };
  };
  if (typeof pull?.number !== 'number' || typeof pull.head?.sha !== 'string') {
    return undefined;
  }
  const headRepo = pull.head.repo?.full_name;
  const defaultBranch = pull.base?.repo?.default_branch;
  return {
    number: pull.number,
    open: pull.state === 'open',
    headSha: pull.head.sha.toLowerCase(),
    ...(typeof headRepo === 'string' ? { headRepo } : {}),
    ...(typeof defaultBranch === 'string' ? { baseDefaultBranch: defaultBranch } : {}),
  };
}
