import {
  CircuitBreakerState,
  QuarantineState,
  afterFullTick,
  afterProbe,
  isQuarantineActive,
  planTick,
  quarantine,
} from './degradation';
import { LsRefsResult, UploadPackRefusedError } from './git/ls-refs';
import { HostKeyMismatchError, SshAuthRejectedError } from './git/ssh';
import { MetaFetch, confirmRotation, parseHostKeyPins, resolveHostKeyPins } from './host-keys';
import { MetricsSink } from './metrics';
import { RefMap, diffRefMaps, observeRefs } from './ref-map';

/**
 * One tick of the tier-1 poller (spec §6.1): ls-refs every configured repo
 * over SSH, diff each answer against the polling table's last-seen ref map,
 * emit the diffs to the bus, THEN commit the new map — emit-then-commit is
 * the pinned ordering; a crash between the two re-emits next tick and the
 * launcher's content-derived dedupe absorbs the duplicates. Commit-then-emit
 * would silently drop pushes and is ruled out by name.
 */

export interface StoredRefMap {
  readonly map: RefMap;
  readonly defaultBranch?: string;
}

/** Polling-table access (C10); `store.ts` provides the DynamoDB implementation. */
export interface PollingStore {
  getRefMap(repo: string): Promise<StoredRefMap | undefined>;
  commitRefMap(
    repo: string,
    map: RefMap,
    defaultBranch: string | undefined,
    nowMs: number,
  ): Promise<void>;
  getQuarantine(repo: string): Promise<QuarantineState | undefined>;
  putQuarantine(repo: string, state: QuarantineState): Promise<void>;
  clearQuarantine(repo: string): Promise<void>;
  getCircuitBreaker(): Promise<CircuitBreakerState>;
  putCircuitBreaker(state: CircuitBreakerState): Promise<void>;
  getReconciledHostKeys(): Promise<string | undefined>;
  putReconciledHostKeys(keys: string, nowMs: number): Promise<void>;
}

/** SSM config-plane reads; `config.ts` provides the implementation. */
export interface ConfigPlane {
  listRepos(): Promise<string[]>;
  getDeployKeys(repos: readonly string[]): Promise<Map<string, string>>;
  evictDeployKey(repo: string): void;
  getHostKeysParameter(): Promise<string | undefined>;
}

/** What the poller puts on the bus: ref diffs, tier-2 `pr` and `cron` fires. */
export interface BusEvent {
  readonly kind: 'push' | 'branch' | 'tag' | 'pr' | 'cron';
  /** Full ref name (for `cron`: the default branch's ref). */
  readonly ref: string;
  readonly sha: string;
  /** Target workflow — `cron` events only. */
  readonly workflow?: string;
  /** Fired UTC minute (`YYYY-MM-DDTHH:mm`) — `cron` events only. */
  readonly minute?: string;
}

/** Bus emission; `bus.ts` provides the EventBridge implementation. */
export interface BusEmitter {
  emit(repo: string, events: readonly BusEvent[], defaultBranch?: string): Promise<void>;
}

/** One ls-refs exchange over SSH; `handler.ts` wires ssh.ts + ls-refs.ts. */
export type Transport = (options: {
  readonly repo: string;
  readonly privateKey: string;
  readonly hostKeyPins: readonly Buffer[];
}) => Promise<LsRefsResult>;

export type Logger = (message: string, fields?: Record<string, unknown>) => void;

export interface PollerDeps {
  readonly store: PollingStore;
  readonly config: ConfigPlane;
  readonly emitter: BusEmitter;
  readonly transport: Transport;
  readonly fetchMeta: MetaFetch;
  readonly metrics: MetricsSink;
  readonly log: Logger;
  readonly now: () => number;
  /** The deployment's `pollCadence`, driving probe/quarantine decay. */
  readonly cadenceMs: number;
  /** Intra-tick SSH session fan-out bound (spec pins 8–10). */
  readonly concurrency: number;
}

export type RepoPollStatus =
  /** Diff events emitted and the new map committed. */
  | 'ok'
  /** No stored map yet — committed a baseline without emitting (the CLI's bootstrap event covers the initial run). */
  | 'baseline'
  /** Nothing changed; nothing written. */
  | 'unchanged'
  /** Active quarantine — not polled this tick. */
  | 'quarantine-skipped'
  /** Repo-local refusal (not found / key rejected) — quarantined. */
  | 'quarantined'
  /** SSH/network failure — counts toward the breaker quorum. */
  | 'transport-failure'
  /** Host-key mismatch outside a confirmed rotation — hard-failed. */
  | 'host-key-failed'
  /** Events could not all be emitted — map NOT committed; next tick re-emits. */
  | 'emit-failed'
  /** Unexpected repo-local failure (oversized map, unreadable item, …). */
  | 'error';

export interface RepoPollOutcome {
  readonly repo: string;
  readonly status: RepoPollStatus;
  readonly eventsEmitted: number;
  readonly error?: string;
}

export interface TickSummary {
  readonly plan: 'full' | 'probe' | 'hold';
  readonly outcomes: readonly RepoPollOutcome[];
  readonly breaker: CircuitBreakerState;
  readonly eventsEmitted: number;
}

/** Once-per-tick host-key rotation reconciliation, shared across repo polls. */
class RotationFlow {
  reconciled = false;
  private confirmation?: Promise<boolean>;

  constructor(
    private readonly deps: PollerDeps,
    private readonly pinsHolder: { pins: readonly Buffer[] },
  ) {}

  /** True when the mismatch turned out to be a confirmed rotation. */
  reconcile(presented: Buffer): Promise<boolean> {
    this.confirmation ??= (async () => {
      const { confirmed, currentKeys } = await confirmRotation(presented, this.deps.fetchMeta);
      if (!confirmed) {
        this.deps.log('host-key mismatch NOT confirmed as rotation by /meta — hard-failing', {
          presentedKey: presented.toString('base64'),
        });
        return false;
      }
      const keys = currentKeys.join('\n');
      await this.deps.store.putReconciledHostKeys(keys, this.deps.now());
      this.pinsHolder.pins = [...this.pinsHolder.pins, ...parseHostKeyPins(keys)];
      this.reconciled = true;
      this.deps.log('host-key rotation confirmed via /meta — pins auto-reconciled', {
        currentKeys,
      });
      return true;
    })();
    return this.confirmation;
  }
}

export async function runTick(deps: PollerDeps): Promise<TickSummary> {
  const startedAt = deps.now();
  const [repos, breaker] = await Promise.all([
    deps.config.listRepos(),
    deps.store.getCircuitBreaker(),
  ]);
  const plan = repos.length === 0 ? ({ mode: 'full' } as const) : planTick(breaker, startedAt);

  if (plan.mode === 'hold' || repos.length === 0) {
    if (plan.mode === 'hold') {
      deps.log('circuit breaker open, next probe pending — holding', { breaker });
    }
    const summary: TickSummary = { plan: plan.mode, outcomes: [], breaker, eventsEmitted: 0 };
    emitTickMetrics(deps, summary, startedAt, false);
    return summary;
  }

  const [ssmPins, reconciledPins] = await Promise.all([
    deps.config.getHostKeysParameter(),
    deps.store.getReconciledHostKeys(),
  ]);
  const pinsHolder = { pins: resolveHostKeyPins(ssmPins, reconciledPins) as readonly Buffer[] };
  const rotation = new RotationFlow(deps, pinsHolder);

  // Probe mode: one canary, rotating with the tick so a long outage exercises
  // different repos. Quarantine is ignored — even a refusal proves transport.
  const probing = plan.mode === 'probe';
  const targets = probing
    ? [repos[Math.floor(startedAt / deps.cadenceMs) % repos.length]]
    : repos;

  const deployKeys = await deps.config.getDeployKeys(targets);
  const outcomes = await mapWithConcurrency(targets, deps.concurrency, (repo) =>
    pollRepo(deps, repo, deployKeys.get(repo), pinsHolder, rotation, probing),
  );

  const transportFailures = outcomes.filter((o) => o.status === 'transport-failure').length;
  const nextBreaker = probing
    ? afterProbe(breaker, isProbeSuccess(outcomes[0]), deps.now(), deps.cadenceMs)
    : afterFullTick(transportFailures, deps.now(), deps.cadenceMs);
  if (breaker.state !== nextBreaker.state || nextBreaker.state === 'open') {
    await deps.store.putCircuitBreaker(nextBreaker);
    if (breaker.state !== nextBreaker.state) {
      deps.log(`circuit breaker ${nextBreaker.state === 'open' ? 'OPENED' : 'closed'}`, {
        transportFailures,
        breaker: nextBreaker,
      });
    }
  }

  const summary: TickSummary = {
    plan: plan.mode,
    outcomes,
    breaker: nextBreaker,
    eventsEmitted: outcomes.reduce((sum, o) => sum + o.eventsEmitted, 0),
  };
  emitTickMetrics(deps, summary, startedAt, rotation.reconciled);
  deps.log('tick complete', {
    plan: plan.mode,
    repos: targets.length,
    eventsEmitted: summary.eventsEmitted,
    transportFailures,
    durationMs: deps.now() - startedAt,
  });
  return summary;
}

/** Transport is healthy when the probe reached the git layer at all. */
function isProbeSuccess(outcome: RepoPollOutcome | undefined): boolean {
  return (
    outcome !== undefined &&
    outcome.status !== 'transport-failure' &&
    outcome.status !== 'host-key-failed'
  );
}

async function pollRepo(
  deps: PollerDeps,
  repo: string,
  privateKey: string | undefined,
  pinsHolder: { pins: readonly Buffer[] },
  rotation: RotationFlow,
  ignoreQuarantine: boolean,
): Promise<RepoPollOutcome> {
  try {
    const existingQuarantine = await deps.store.getQuarantine(repo);
    if (!ignoreQuarantine && isQuarantineActive(existingQuarantine, deps.now())) {
      return { repo, status: 'quarantine-skipped', eventsEmitted: 0 };
    }
    if (!privateKey) {
      return await quarantineRepo(deps, repo, existingQuarantine, 'deploy-key parameter missing');
    }

    let result: LsRefsResult;
    try {
      result = await exchangeWithRotationRetry(deps, repo, privateKey, pinsHolder, rotation);
    } catch (err) {
      if (err instanceof HostKeyMismatchError) {
        deps.log('host-key mismatch outside a confirmed rotation — hard-failing poll', { repo });
        return { repo, status: 'host-key-failed', eventsEmitted: 0, error: err.message };
      }
      if (err instanceof UploadPackRefusedError || err instanceof SshAuthRejectedError) {
        // A rotated deploy key must not be pinned in the warm cache forever.
        deps.config.evictDeployKey(repo);
        return await quarantineRepo(deps, repo, existingQuarantine, err.message);
      }
      deps.log('transport failure', { repo, error: (err as Error).message });
      return { repo, status: 'transport-failure', eventsEmitted: 0, error: (err as Error).message };
    }

    if (result.protocolVersion === 0) {
      deps.log('server ignored GIT_PROTOCOL=version=2 — parsed the v0 advertisement', { repo });
    }
    const observed = observeRefs(result.refs);

    let stored: StoredRefMap | undefined;
    try {
      stored = await deps.store.getRefMap(repo);
    } catch (err) {
      // Unreadable map: re-baseline. Loud — the events since the last good
      // commit are lost, exactly what emit-then-commit otherwise prevents.
      deps.log('stored ref map unreadable — re-baselining, intermediate events lost', {
        repo,
        error: (err as Error).message,
      });
    }

    if (existingQuarantine) {
      await deps.store.clearQuarantine(repo);
      deps.log('quarantine lifted after successful poll', { repo });
    }

    if (stored === undefined) {
      await deps.store.commitRefMap(repo, observed.map, observed.defaultBranch, deps.now());
      return { repo, status: 'baseline', eventsEmitted: 0 };
    }

    const events = diffRefMaps(stored.map, observed);
    if (events.length > 0) {
      try {
        await deps.emitter.emit(repo, events, observed.defaultBranch);
      } catch (err) {
        // Emit failed ⇒ NO commit: the next tick re-diffs against the old
        // map and re-emits. Partial batches downstream are dedupe-absorbed.
        deps.log('event emission failed — ref map NOT committed, next tick re-emits', {
          repo,
          error: (err as Error).message,
        });
        return { repo, status: 'emit-failed', eventsEmitted: 0, error: (err as Error).message };
      }
    }

    const mapChanged =
      events.length > 0 ||
      Object.keys(stored.map).length !== Object.keys(observed.map).length ||
      stored.defaultBranch !== observed.defaultBranch;
    if (!mapChanged) {
      return { repo, status: 'unchanged', eventsEmitted: 0 };
    }
    await deps.store.commitRefMap(repo, observed.map, observed.defaultBranch, deps.now());
    return { repo, status: 'ok', eventsEmitted: events.length };
  } catch (err) {
    deps.log('repo poll failed', { repo, error: (err as Error).message });
    return { repo, status: 'error', eventsEmitted: 0, error: (err as Error).message };
  }
}

async function exchangeWithRotationRetry(
  deps: PollerDeps,
  repo: string,
  privateKey: string,
  pinsHolder: { pins: readonly Buffer[] },
  rotation: RotationFlow,
): Promise<LsRefsResult> {
  try {
    return await deps.transport({ repo, privateKey, hostKeyPins: pinsHolder.pins });
  } catch (err) {
    if (err instanceof HostKeyMismatchError && (await rotation.reconcile(err.presentedKey))) {
      return await deps.transport({ repo, privateKey, hostKeyPins: pinsHolder.pins });
    }
    throw err;
  }
}

async function quarantineRepo(
  deps: PollerDeps,
  repo: string,
  previous: QuarantineState | undefined,
  reason: string,
): Promise<RepoPollOutcome> {
  const state = quarantine(previous, reason, deps.now());
  await deps.store.putQuarantine(repo, state);
  deps.log('repo quarantined', { repo, reason, retryAt: new Date(state.retryAt).toISOString() });
  return { repo, status: 'quarantined', eventsEmitted: 0, error: reason };
}

function emitTickMetrics(
  deps: PollerDeps,
  summary: TickSummary,
  startedAt: number,
  rotationReconciled: boolean,
): void {
  const count = (status: RepoPollStatus) =>
    summary.outcomes.filter((o) => o.status === status).length;
  deps.metrics({
    TickDurationMs: deps.now() - startedAt,
    ReposPolled: summary.outcomes.length - count('quarantine-skipped'),
    RefEventsEmitted: summary.eventsEmitted,
    TransportFailures: count('transport-failure'),
    QuarantinedRepos: count('quarantined') + count('quarantine-skipped'),
    CircuitBreakerOpen: summary.breaker.state === 'open' ? 1 : 0,
    HostKeyRotationReconciled: rotationReconciled ? 1 : 0,
    HostKeyHardFailures: count('host-key-failed'),
  });
}

/** Bounded fan-out (spec §6.1 pins 8–10 parallel sessions). Order-preserving. */
export async function mapWithConcurrency<T, R>(
  items: readonly T[],
  limit: number,
  fn: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, async () => {
      for (let i = next++; i < items.length; i = next++) {
        results[i] = await fn(items[i], i);
      }
    }),
  );
  return results;
}
