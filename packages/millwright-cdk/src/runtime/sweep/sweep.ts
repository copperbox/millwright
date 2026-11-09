import {
  ConcurrencyGroupItem,
  KeyFormatError,
  RunCoordinates,
  RunItem,
  TERMINAL_RUN_STATUSES,
  parseConcurrencyGroupKey,
  parseRunId,
} from '@copperbox/millwright-state';
import {
  ExecutionInspector,
  carryOverExecutionName,
  runExecutionName,
} from '../shared/executions';
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
 *
 * A run row that never turned terminal is the other way a slot jams (issue
 * #50): a synth failure before this release existed, or a decider that died
 * past its retry budget, leaves the run PENDING/RUNNING with no execution to
 * ever finish it. An occupant whose Step Functions execution has CLOSED is
 * therefore treated as finished too — marked FAILED, then released — since
 * nothing else will move it. Liveness follows the carry-over chain: a long
 * run's launcher-named execution closes legitimately when it hands the loop
 * to its deterministic successor.
 */

export interface SweepStore extends GroupSlotStore {
  /** Every `GROUP#` item in the state table. */
  listGroups(): Promise<readonly ConcurrencyGroupItem[]>;
  /** The shared conditional terminal transition; false when already terminal. */
  finishRun(coords: RunCoordinates, status: RunItem['status'], nowMs: number): Promise<boolean>;
}

export interface SweepDeps {
  readonly store: SweepStore;
  readonly starter: PendingRunStarter;
  /** `DescribeExecution` on the run executor — the occupant liveness check. */
  readonly executions: ExecutionInspector;
  readonly log: (message: string, fields?: Record<string, unknown>) => void;
}

/**
 * Carry-over generations the liveness walk follows before giving up and
 * calling the run live. At 500 iterations × 60 s per execution and a 24 h
 * default run deadline, real chains are a handful of hops.
 */
export const MAX_CARRY_OVER_HOPS = 64;

/**
 * Whether a non-terminal run's execution chain has closed. The launcher's
 * execution is hop 0: if it does not exist yet the launcher is mid-flight
 * (slot claimed, StartExecution pending) and the run is live. Each closed
 * generation may have carried over to its deterministic successor; a missing
 * successor means the chain ended there — closed for good.
 */
export async function runExecutionClosed(
  executions: ExecutionInspector,
  run: RunItem,
): Promise<boolean> {
  let name = runExecutionName(run);
  for (let hop = 0; hop <= MAX_CARRY_OVER_HOPS; hop++) {
    const liveness = await executions.describe(name);
    if (liveness === 'running') {
      return false;
    }
    if (liveness === 'missing') {
      return hop > 0;
    }
    name = carryOverExecutionName(name);
  }
  return false; // too deep to follow — leave the slot alone rather than guess
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
  /** Non-terminal occupants whose execution had closed, marked FAILED. */
  readonly failed: number;
}

export async function sweepGroups(deps: SweepDeps, nowMs: number): Promise<SweepReport> {
  const { store, log } = deps;
  const items = await store.listGroups();
  let healthy = 0;
  let cleared = 0;
  let handedOff = 0;
  let failed = 0;
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
    let coords: RunCoordinates;
    try {
      coords = parseRunId(running);
    } catch (err) {
      if (!(err instanceof KeyFormatError)) {
        throw err;
      }
      log('group running slot holds an unparseable run id; skipping', { group, running });
      continue;
    }
    const run = await store.getRun(coords);
    if (run !== undefined && !TERMINAL_RUN_STATUSES.includes(run.status)) {
      if (!(await runExecutionClosed(deps.executions, run))) {
        healthy++;
        continue;
      }
      // Nothing will ever finish this run: its execution is gone. Close it
      // the way the decider would have, then release the slot it holds.
      if (await store.finishRun(coords, 'FAILED', nowMs)) {
        failed++;
        log('run execution closed without a terminal status; marked FAILED', {
          group,
          runId: running,
          status: run.status,
        });
      }
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
  return { groups: items.length, healthy, cleared, handedOff, failed };
}
