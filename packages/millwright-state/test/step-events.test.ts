import { describe, expect, it } from 'vitest';
import {
  EVENT_BUS_ENV,
  STEP_EVENTS_FILE_ENV,
  STEP_EVENT_DETAIL_TYPE,
  STEP_EVENT_SOURCE,
  StepEventDetail,
  stepEventDetail,
  validateStepEvent,
} from '../src';

const DETAIL: StepEventDetail = {
  runId: 'octocat/app#ci#142',
  job: 'build',
  stepIndex: 2,
  status: 'RUNNING',
  name: 'compile',
  startedAt: '2026-08-12T10:00:00.000Z',
};

function validate(overrides: Partial<Record<keyof StepEventDetail, unknown>> = {}) {
  return validateStepEvent(STEP_EVENT_SOURCE, STEP_EVENT_DETAIL_TYPE, {
    ...DETAIL,
    ...overrides,
  });
}

describe('validateStepEvent', () => {
  it('accepts a well-formed start event and parses the run identity', () => {
    const result = validate();
    if (!result.ok) {
      throw new Error(result.reason);
    }
    expect(result.event).toEqual({
      coords: { repo: 'octocat/app', workflow: 'ci', runNumber: 142 },
      job: 'build',
      stepIndex: 2,
      status: 'RUNNING',
      name: 'compile',
      startedAt: '2026-08-12T10:00:00.000Z',
      finishedAt: undefined,
      reason: undefined,
    });
  });

  it('accepts a terminal event carrying both timestamps', () => {
    const result = validate({
      status: 'SUCCEEDED',
      finishedAt: '2026-08-12T10:00:07.500Z',
    });
    expect(result.ok).toBe(true);
  });

  it('accepts a SKIPPED event with reason skip_if', () => {
    const result = validate({ status: 'SKIPPED', reason: 'skip_if' });
    if (!result.ok) {
      throw new Error(result.reason);
    }
    expect(result.event.status).toBe('SKIPPED');
    expect(result.event.reason).toBe('skip_if');
  });

  it('rejects any source other than millwright.step', () => {
    const result = validateStepEvent('millwright.cli', STEP_EVENT_DETAIL_TYPE, DETAIL);
    expect(result).toMatchObject({ ok: false });
    if (!result.ok) {
      expect(result.reason).toContain('millwright.step');
    }
  });

  it('rejects unknown detail-types', () => {
    expect(validateStepEvent(STEP_EVENT_SOURCE, 'push', DETAIL).ok).toBe(false);
  });

  it('rejects non-object details', () => {
    expect(validateStepEvent(STEP_EVENT_SOURCE, STEP_EVENT_DETAIL_TYPE, 'nope').ok).toBe(false);
    expect(validateStepEvent(STEP_EVENT_SOURCE, STEP_EVENT_DETAIL_TYPE, null).ok).toBe(false);
    expect(validateStepEvent(STEP_EVENT_SOURCE, STEP_EVENT_DETAIL_TYPE, [DETAIL]).ok).toBe(false);
  });

  it('rejects an unparseable run id', () => {
    expect(validate({ runId: 'not-a-run-id' }).ok).toBe(false);
    expect(validate({ runId: 'octocat/app#ci#0' }).ok).toBe(false);
    expect(validate({ runId: 7 }).ok).toBe(false);
  });

  it('rejects a job name that is empty or would break the sort key', () => {
    expect(validate({ job: '' }).ok).toBe(false);
    expect(validate({ job: 'a#b' }).ok).toBe(false);
    expect(validate({ job: 42 }).ok).toBe(false);
  });

  it('rejects step indexes outside the key range', () => {
    expect(validate({ stepIndex: -1 }).ok).toBe(false);
    expect(validate({ stepIndex: 1.5 }).ok).toBe(false);
    expect(validate({ stepIndex: 10000 }).ok).toBe(false);
    expect(validate({ stepIndex: '2' }).ok).toBe(false);
  });

  it('rejects unknown statuses', () => {
    expect(validate({ status: 'PENDING' }).ok).toBe(false);
    expect(validate({ status: undefined }).ok).toBe(false);
  });

  it('rejects a reason on any status but SKIPPED, and unknown reasons', () => {
    expect(validate({ reason: 'skip_if' }).ok).toBe(false);
    expect(validate({ status: 'SKIPPED', reason: 'upstream_failed' }).ok).toBe(false);
  });

  it('rejects malformed timestamps', () => {
    expect(validate({ startedAt: 'yesterday' }).ok).toBe(false);
    expect(validate({ status: 'SUCCEEDED', finishedAt: 1754993000 }).ok).toBe(false);
  });

  it('rejects a non-string name', () => {
    expect(validate({ name: 42 }).ok).toBe(false);
  });

  it('tolerates absent optional fields', () => {
    const result = validateStepEvent(STEP_EVENT_SOURCE, STEP_EVENT_DETAIL_TYPE, {
      runId: 'octocat/app#ci#142',
      job: 'build',
      stepIndex: 0,
      status: 'FAILED',
    });
    expect(result.ok).toBe(true);
  });
});

describe('stepEventDetail', () => {
  it('builds a detail payload the validator accepts, dropping undefined fields', () => {
    const detail = stepEventDetail({
      runId: 'octocat/app#ci#142',
      job: 'build',
      stepIndex: 0,
      status: 'SKIPPED',
      reason: 'skip_if',
      startedAt: '2026-08-12T10:00:00.000Z',
      finishedAt: '2026-08-12T10:00:01.000Z',
    });
    expect('name' in detail).toBe(false);
    expect(validateStepEvent(STEP_EVENT_SOURCE, STEP_EVENT_DETAIL_TYPE, detail).ok).toBe(true);
  });

  it('throws on payloads the validator would reject', () => {
    expect(() =>
      stepEventDetail({ runId: 'nope', job: 'build', stepIndex: 0, status: 'RUNNING' }),
    ).toThrow(/run/i);
  });
});

describe('sink env contract', () => {
  it('pins the env names the shim and dispatch share', () => {
    expect(EVENT_BUS_ENV).toBe('MILLWRIGHT_EVENT_BUS');
    expect(STEP_EVENTS_FILE_ENV).toBe('MILLWRIGHT_STEP_EVENTS_FILE');
  });
});
