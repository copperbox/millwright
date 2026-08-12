import { BRANCH_REF_PREFIX, RegistryItem } from '@copperbox/millwright-state';
import {
  CronParseError,
  MINUTE_MS,
  formatMinute,
  latestMatchingMinute,
  minuteFloor,
  parseCronExpression,
  parseMinute,
} from './cron';
import { CronMetricsSink } from './metrics';
import { BusEmitter, Logger, StoredRefMap } from './poller';

/**
 * The cron pass (spec §6.4): the poller tick doubles as the cron clock. Per
 * cron entry — keyed (repo, workflow, expression) — the polling table holds a
 * `last-fired-minute`; each tick computes the minutes in `(last-fired, now]`
 * matching the expression and fires AT MOST the latest one (bounded catch-up,
 * no post-outage thundering herd), emit-then-commit like tier 1: a crash
 * between the two re-emits next tick and the launcher's minute-qualified
 * dedupe identity (`cron#<repo>#<wf>#<minute>` content) cancels the
 * double-fire exactly.
 *
 * Cron is ref-less: entries are read from the repo's DEFAULT-BRANCH registry
 * entry (guaranteed by the §8.3 bootstrap) and always run the default-branch
 * head, taken from the polling table's committed ref map. Everything is UTC.
 * Granularity degrades to the poll cadence — a `* * * * *` entry under a
 * 5-minute cadence fires once per tick, for the tick's own minute.
 */

/** The polling-table slice the cron pass reads and writes. */
export interface CronPollingStore {
  getRefMap(repo: string): Promise<StoredRefMap | undefined>;
  getCronLastFired(repo: string, workflow: string, expression: string): Promise<string | undefined>;
  putCronLastFired(
    repo: string,
    workflow: string,
    expression: string,
    minute: string,
    nowMs: number,
  ): Promise<void>;
}

/** Read-only registry access (state-table `REG#` rows, spec §8.3). */
export interface CronRegistryReader {
  getRegistryEntry(repo: string, ref: string): Promise<RegistryItem | undefined>;
}

export interface CronTickDeps {
  readonly store: CronPollingStore;
  readonly registry: CronRegistryReader;
  readonly emitter: BusEmitter;
  readonly listRepos: () => Promise<string[]>;
  readonly metrics: CronMetricsSink;
  readonly log: Logger;
  readonly now: () => number;
}

export interface CronTickSummary {
  readonly entriesEvaluated: number;
  readonly eventsEmitted: number;
  readonly invalidExpressions: number;
  readonly errors: number;
}

interface Tally {
  entriesEvaluated: number;
  eventsEmitted: number;
  invalidExpressions: number;
  errors: number;
}

export async function runCronTick(deps: CronTickDeps): Promise<CronTickSummary> {
  const tally: Tally = { entriesEvaluated: 0, eventsEmitted: 0, invalidExpressions: 0, errors: 0 };
  const repos = await deps.listRepos();
  for (const repo of repos) {
    try {
      await evaluateRepo(deps, repo, tally);
    } catch (err) {
      tally.errors++;
      deps.log('cron pass failed for repo', { repo, error: (err as Error).message });
    }
  }
  deps.metrics({
    CronEntriesEvaluated: tally.entriesEvaluated,
    CronEventsEmitted: tally.eventsEmitted,
    CronInvalidExpressions: tally.invalidExpressions,
    CronErrors: tally.errors,
  });
  return tally;
}

async function evaluateRepo(deps: CronTickDeps, repo: string, tally: Tally): Promise<void> {
  const stored = await deps.store.getRefMap(repo);
  if (!stored?.defaultBranch) {
    // Never successfully polled (or HEAD symref unknown): there is no head to
    // run against yet. The next tier-1 tick fills this in.
    return;
  }
  const defaultRef = `${BRANCH_REF_PREFIX}${stored.defaultBranch}`;
  const headSha = stored.map[defaultRef];
  if (!headSha) {
    deps.log('cron skipped: default branch missing from stored ref map', { repo, defaultRef });
    return;
  }
  const registry = await deps.registry.getRegistryEntry(repo, defaultRef);
  if (!registry) {
    // No default-branch registry entry yet — the §8.3 bootstrap owns fixing
    // that (and `doctor` fails loudly on it); cron never guesses triggers.
    return;
  }

  const workflows =
    typeof registry.workflows === 'object' && registry.workflows !== null ? registry.workflows : {};
  for (const workflow of Object.keys(workflows).sort()) {
    const triggers = (workflows[workflow] as { triggers?: unknown })?.triggers;
    if (!Array.isArray(triggers)) {
      deps.log('cron skipped workflow with uninterpretable registry triggers', { repo, workflow });
      continue;
    }
    for (const trigger of triggers) {
      const kind = (trigger as { kind?: unknown })?.kind;
      const expression = (trigger as { expression?: unknown })?.expression;
      if (kind !== 'cron') {
        continue;
      }
      if (typeof expression !== 'string') {
        deps.log('cron trigger without an expression — skipping (fail closed)', { repo, workflow });
        tally.invalidExpressions++;
        continue;
      }
      tally.entriesEvaluated++;
      await evaluateEntry(deps, { repo, workflow, expression, defaultRef, headSha }, tally);
    }
  }
}

interface CronEntry {
  readonly repo: string;
  readonly workflow: string;
  readonly expression: string;
  readonly defaultRef: string;
  readonly headSha: string;
}

async function evaluateEntry(deps: CronTickDeps, entry: CronEntry, tally: Tally): Promise<void> {
  const { repo, workflow, expression } = entry;
  let parsed;
  try {
    parsed = parseCronExpression(expression);
  } catch (err) {
    if (err instanceof CronParseError) {
      tally.invalidExpressions++;
      deps.log('unparseable cron expression — skipping (fail closed)', {
        repo,
        workflow,
        expression,
        error: err.message,
      });
      return;
    }
    throw err;
  }

  const nowMs = deps.now();
  const lastFired = await deps.store.getCronLastFired(repo, workflow, expression);
  let afterMs: number;
  try {
    // A fresh (or unreadable) entry baselines to the previous minute: only the
    // current minute can fire, never a backlog reaching into the past.
    afterMs = lastFired !== undefined ? parseMinute(lastFired) : minuteFloor(nowMs) - MINUTE_MS;
  } catch {
    deps.log('unreadable cron last-fired minute — re-baselining', { repo, workflow, lastFired });
    afterMs = minuteFloor(nowMs) - MINUTE_MS;
  }
  const target = latestMatchingMinute(parsed, afterMs, nowMs);
  if (target === undefined) {
    return;
  }

  const minute = formatMinute(target);
  const branch = entry.defaultRef.slice(BRANCH_REF_PREFIX.length);
  try {
    // Emit-then-commit: a crash (or failure) between the two re-fires next
    // tick and the launcher's minute-qualified dedupe absorbs it.
    await deps.emitter.emit(
      repo,
      [{ kind: 'cron', ref: entry.defaultRef, sha: entry.headSha, workflow, minute }],
      branch,
    );
  } catch (err) {
    tally.errors++;
    deps.log('cron emit failed — last-fired NOT committed, next tick re-fires', {
      repo,
      workflow,
      minute,
      error: (err as Error).message,
    });
    return;
  }
  tally.eventsEmitted++;
  await deps.store.putCronLastFired(repo, workflow, expression, minute, nowMs);
}
