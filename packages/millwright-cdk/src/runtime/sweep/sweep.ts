import {
  ConcurrencyGroupItem,
  KeyFormatError,
  TERMINAL_RUN_STATUSES,
  parseConcurrencyGroupKey,
  parseRunId,
} from '@copperbox/millwright-state';
import { GroupSlotStore, PendingRunStarter, releaseGroupSlot } from '../shared/groups';

/**
 * The sweep's concurrency-group repair (spec §8.4, C16): every minute, find
 * groups whose running run is terminal but whose slot never cleared — the
 * decider crashed between run completion and its release — and re-run the
 * shared release convergence, which starts the pending run and hands the
 * slot over (or just clears it).
 *
 * The sweep repairs group slots; it does NOT resurrect executions. A missing
 * run record counts as terminal: run-level caps guarantee dead executions
 * don't exist, so a slot pointing at an unknown run can only be stale.
 */

export interface SweepStore extends GroupSlotStore {
  /** Every `GROUP#` item in the state table. */
  listGroups(): Promise<readonly ConcurrencyGroupItem[]>;
}

export interface SweepDeps {
  readonly store: SweepStore;
  readonly starter: PendingRunStarter;
  readonly log: (message: string, fields?: Record<string, unknown>) => void;
}

export interface SweepReport {
  /** Groups scanned. */
  readonly groups: number;
  /** Groups whose running run was live — left untouched. */
  readonly healthy: number;
  /** Stale slots cleared (no waiter). */
  readonly cleared: number;
  /** Pending runs started and promoted into freed slots. */
  readonly handedOff: number;
}

export async function sweepGroups(deps: SweepDeps, nowMs: number): Promise<SweepReport> {
  const { store, log } = deps;
  const items = await store.listGroups();
  let healthy = 0;
  let cleared = 0;
  let handedOff = 0;
  for (const item of items) {
    const { group } = parseConcurrencyGroupKey(item);
    const running = item.running;
    if (!running) {
      // Unreachable by the claim/release protocol (a pending claim requires a
      // running occupant; a clear requires no waiter) — worth a loud log.
      if (item.pending) {
        log('group has a waiter but no running occupant', { group, pending: item.pending });
      }
      healthy++;
      continue;
    }
    let live: boolean;
    try {
      const run = await store.getRun(parseRunId(running));
      live = run !== undefined && !TERMINAL_RUN_STATUSES.includes(run.status);
    } catch (err) {
      if (!(err instanceof KeyFormatError)) {
        throw err;
      }
      log('group running slot holds an unparseable run id; skipping', { group, running });
      continue;
    }
    if (live) {
      healthy++;
      continue;
    }
    const outcome = await releaseGroupSlot(deps, group, running, nowMs);
    log('repaired stale group slot', { group, finished: running, outcome });
    if (outcome === 'handed-off') {
      handedOff++;
    } else if (outcome === 'cleared') {
      cleared++;
    }
    // The convergence races count as neither: 'not-held' (someone else
    // repaired first) and 'contended' (next tick retries).
  }
  return { groups: items.length, healthy, cleared, handedOff };
}
