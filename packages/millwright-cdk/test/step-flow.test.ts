import {
  ItemKey,
  STEP_EVENT_DETAIL_TYPE,
  STEP_EVENT_SOURCE,
  StepEventDetail,
  StepItem,
  ValidStepEvent,
  expiresAtAfterDays,
  stepKey,
} from '@copperbox/millwright-state';
import { describe, expect, it } from 'vitest';
import {
  StepEventsStore,
  processStepEvent,
} from '../src/runtime/step-events/step-events';
import { StepEventEmitter, runStep } from '../src/runtime/shim/shim';

/**
 * Acceptance flow (issue #13): the shim's emitted events, delivered through
 * the writer — including duplicated and out-of-order deliveries, the
 * EventBridge realities the idempotency criterion is about.
 */

const NOW = Date.parse('2026-08-12T06:00:00Z');
const RETENTION_DAYS = 90;

/** In-memory stand-in honoring the Dynamo store's upsert semantics. */
class TableStore implements StepEventsStore {
  readonly rows = new Map<string, StepItem>();

  async writeStepRow(event: ValidStepEvent, nowMs: number): Promise<'written' | 'superseded'> {
    const key: ItemKey = stepKey(event.coords, event.job, event.stepIndex);
    const id = `${key.pk}|${key.sk}`;
    const existing = this.rows.get(id);
    if (event.status === 'RUNNING' && existing && existing.status !== 'RUNNING') {
      return 'superseded';
    }
    const patch = Object.fromEntries(
      Object.entries({
        name: event.name,
        reason: event.reason,
        startedAt: event.startedAt,
        finishedAt: event.finishedAt,
      }).filter(([, value]) => value !== undefined),
    );
    this.rows.set(id, {
      ...(existing ?? {}),
      ...key,
      repo: event.coords.repo,
      workflow: event.coords.workflow,
      runNumber: event.coords.runNumber,
      job: event.job,
      stepIndex: event.stepIndex,
      status: event.status,
      expiresAt: expiresAtAfterDays(nowMs, RETENTION_DAYS),
      ...patch,
    } as StepItem);
    return 'written';
  }
}

function collector(): { emitter: StepEventEmitter; emitted: StepEventDetail[] } {
  const emitted: StepEventDetail[] = [];
  return { emitted, emitter: { emit: async (detail) => void emitted.push(detail) } };
}

async function deliver(store: TableStore, detail: StepEventDetail): Promise<string> {
  return processStepEvent(
    { store, log: () => {} },
    { source: STEP_EVENT_SOURCE, 'detail-type': STEP_EVENT_DETAIL_TYPE, detail },
    NOW,
  );
}

describe('shim → writer flow', () => {
  it('duplicate delivery of every event still yields exactly one row per (run, job, step-index)', async () => {
    const { emitter, emitted } = collector();
    let tick = 0;
    const deps = {
      runner: { run: async () => 0 },
      emitter,
      clock: () => NOW + 1000 * tick++,
      warn: () => {},
    };
    const identity = { runId: 'octo/app#ci#7', job: 'build' };
    await runStep(deps, identity, { index: 0, name: 'compile', command: 'make' });
    await runStep(deps, identity, { index: 1, skipIf: 'true', command: 'make deploy' });

    const store = new TableStore();
    for (const detail of emitted) {
      expect(await deliver(store, detail)).toBe('written');
      await deliver(store, detail); // EventBridge redelivery
    }

    expect(store.rows.size).toBe(2);
    const rows = [...store.rows.values()].sort((a, b) => a.stepIndex - b.stepIndex);
    expect(rows[0]).toMatchObject({
      pk: 'RUN#octo/app#ci#7',
      sk: 'JOB#build#STEP#0000',
      status: 'SUCCEEDED',
      name: 'compile',
      startedAt: '2026-08-12T06:00:00.000Z',
      finishedAt: '2026-08-12T06:00:01.000Z',
    });
    expect(rows[1]).toMatchObject({
      sk: 'JOB#build#STEP#0001',
      status: 'SKIPPED',
      reason: 'skip_if',
    });
  });

  it('a RUNNING redelivered after the terminal event never regresses the row', async () => {
    const { emitter, emitted } = collector();
    let tick = 0;
    await runStep(
      { runner: { run: async () => 2 }, emitter, clock: () => NOW + 1000 * tick++, warn: () => {} },
      { runId: 'octo/app#ci#7', job: 'build' },
      { index: 0, command: 'make' },
    );
    const [running, failed] = emitted;

    const store = new TableStore();
    await deliver(store, running);
    await deliver(store, failed);
    expect(await deliver(store, running)).toBe('superseded');

    const [row] = [...store.rows.values()];
    expect(row.status).toBe('FAILED');
    expect(row.finishedAt).toBeDefined();
  });
});
