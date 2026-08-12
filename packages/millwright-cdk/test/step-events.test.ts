import {
  STEP_EVENT_DETAIL_TYPE,
  STEP_EVENT_SOURCE,
  StepEventDetail,
  ValidStepEvent,
} from '@copperbox/millwright-state';
import { describe, expect, it } from 'vitest';
import {
  StepBusEvent,
  StepEventsDeps,
  StepEventsStore,
  processStepEvent,
} from '../src/runtime/step-events/step-events';

const NOW = Date.parse('2026-08-12T06:00:00Z');

const DETAIL: StepEventDetail = {
  runId: 'octo/app#ci#7',
  job: 'build',
  stepIndex: 1,
  status: 'RUNNING',
  name: 'compile',
  startedAt: '2026-08-12T06:00:00.000Z',
};

function busEvent(detail: unknown = DETAIL, source = STEP_EVENT_SOURCE): StepBusEvent {
  return { source, 'detail-type': STEP_EVENT_DETAIL_TYPE, detail };
}

class MemoryStore implements StepEventsStore {
  readonly written: ValidStepEvent[] = [];
  nextDisposition: 'written' | 'superseded' = 'written';

  async writeStepRow(event: ValidStepEvent): Promise<'written' | 'superseded'> {
    this.written.push(event);
    return this.nextDisposition;
  }
}

function deps(store = new MemoryStore()): {
  store: MemoryStore;
  deps: StepEventsDeps;
  logged: Array<Record<string, unknown> | undefined>;
} {
  const logged: Array<Record<string, unknown> | undefined> = [];
  return { store, logged, deps: { store, log: (_msg, fields) => logged.push(fields) } };
}

describe('processStepEvent (C19 core)', () => {
  it('writes the step row for a valid event with the run identity parsed', async () => {
    const { store, deps: d } = deps();
    const disposition = await processStepEvent(d, busEvent(), NOW);
    expect(disposition).toBe('written');
    expect(store.written).toEqual([
      {
        coords: { repo: 'octo/app', workflow: 'ci', runNumber: 7 },
        job: 'build',
        stepIndex: 1,
        status: 'RUNNING',
        name: 'compile',
        reason: undefined,
        startedAt: '2026-08-12T06:00:00.000Z',
        finishedAt: undefined,
      },
    ]);
  });

  it('surfaces the store fencing a late RUNNING as superseded', async () => {
    const { store, deps: d } = deps();
    store.nextDisposition = 'superseded';
    expect(await processStepEvent(d, busEvent(), NOW)).toBe('superseded');
  });

  it('drops events from any source but millwright.step without writing', async () => {
    const { store, deps: d, logged } = deps();
    const disposition = await processStepEvent(d, busEvent(DETAIL, 'millwright.cli'), NOW);
    expect(disposition).toBe('rejected');
    expect(store.written).toHaveLength(0);
    expect(JSON.stringify(logged)).toContain('millwright.step');
  });

  it('drops malformed details without writing — redelivery cannot repair shape', async () => {
    const { store, deps: d } = deps();
    expect(await processStepEvent(d, busEvent({ ...DETAIL, stepIndex: 'one' }), NOW)).toBe(
      'rejected',
    );
    expect(await processStepEvent(d, busEvent(null), NOW)).toBe('rejected');
    expect(await processStepEvent(d, { detail: DETAIL }, NOW)).toBe('rejected');
    expect(store.written).toHaveLength(0);
  });

  it('propagates store errors so EventBridge redelivers', async () => {
    const failing: StepEventsStore = {
      writeStepRow: async () => {
        throw new Error('throttled');
      },
    };
    await expect(
      processStepEvent({ store: failing, log: () => {} }, busEvent(), NOW),
    ).rejects.toThrow('throttled');
  });
});
