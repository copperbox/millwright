import { describe, expect, it } from 'vitest';
import {
  DEFAULT_RUN_DEADLINE_MINUTES,
  DeciderJobState,
  MAX_RUN_DEADLINE_MINUTES,
  RunModelWorkflow,
  STALE_DISPATCH_MS,
  decide,
  effectiveJobStatus,
} from '../src';

const NOW = Date.parse('2026-08-12T06:00:00Z');
const CLOCK = { nowMs: NOW, anchorMs: NOW - 60_000 };

function workflow(
  jobs: {
    name: string;
    dependsOn?: string[];
    consumes?: { job: string; artifact: string }[];
    attempts?: number;
  }[],
  deadlineMinutes?: number,
): RunModelWorkflow {
  return {
    name: 'ci',
    deadlineMinutes,
    jobs: jobs.map((j) => ({ ...j, steps: [{ run: 'true' }] })),
  };
}

function states(entries: Record<string, Partial<DeciderJobState>>) {
  return Object.fromEntries(
    Object.entries(entries).map(([name, s]) => [name, { attempts: 0, ...s }]),
  );
}

const succeeded = (id: string): Partial<DeciderJobState> => ({
  attempts: 1,
  buildId: id,
  buildOutcome: 'SUCCEEDED',
  tableStatus: 'SUCCEEDED',
});
const running = (id: string): Partial<DeciderJobState> => ({
  attempts: 1,
  buildId: id,
  buildOutcome: 'IN_PROGRESS',
  tableStatus: 'RUNNING',
});
const failed = (id: string): Partial<DeciderJobState> => ({
  attempts: 1,
  buildId: id,
  buildOutcome: 'FAILED',
  tableStatus: 'FAILED',
});

describe('decide — dispatch-on-completion', () => {
  const diamond = workflow([
    { name: 'build' },
    { name: 'test', dependsOn: ['build'] },
    { name: 'lint', dependsOn: ['build'] },
    { name: 'deploy', consumes: [{ job: 'test', artifact: 'dist' }], dependsOn: ['lint'] },
  ]);

  it('dispatches only dependency-free jobs on first entry', () => {
    const actions = decide(diamond, {}, false, CLOCK);
    expect(actions.dispatch).toEqual(['build']);
    expect(actions.runStatus).toBe('RUNNING');
    expect(actions.markJobs).toEqual([]);
  });

  it('dispatches every job whose deps just completed', () => {
    const actions = decide(diamond, states({ build: succeeded('b1') }), false, CLOCK);
    expect(actions.dispatch).toEqual(['test', 'lint']);
    expect(actions.runStatus).toBe('RUNNING');
  });

  it('holds a join job until every dependency succeeded', () => {
    const midway = states({ build: succeeded('b1'), test: succeeded('b2'), lint: running('b3') });
    expect(decide(diamond, midway, false, CLOCK).dispatch).toEqual([]);

    const done = states({ build: succeeded('b1'), test: succeeded('b2'), lint: succeeded('b3') });
    expect(decide(diamond, done, false, CLOCK).dispatch).toEqual(['deploy']);
  });

  it('reports SUCCEEDED once every job succeeded', () => {
    const all = states({
      build: succeeded('b1'),
      test: succeeded('b2'),
      lint: succeeded('b3'),
      deploy: succeeded('b4'),
    });
    const actions = decide(diamond, all, false, CLOCK);
    expect(actions).toEqual({
      dispatch: [],
      stopBuilds: [],
      markJobs: [],
      runStatus: 'SUCCEEDED',
    });
  });

  it('is idempotent: re-entry on identical state returns identical actions', () => {
    const midway = states({ build: succeeded('b1') });
    expect(decide(diamond, midway, false, CLOCK)).toEqual(decide(diamond, midway, false, CLOCK));
  });
});

describe('decide — failure and skip propagation', () => {
  const chain = workflow([
    { name: 'build' },
    { name: 'test', dependsOn: ['build'] },
    { name: 'deploy', dependsOn: ['test'] },
    { name: 'docs' },
  ]);

  it('skips transitive dependents of a failed job while independent branches continue', () => {
    const actions = decide(chain, states({ build: failed('b1') }), false, CLOCK);
    expect(actions.markJobs).toEqual([
      { job: 'test', status: 'SKIPPED', skipReason: 'upstream_failed' },
      { job: 'deploy', status: 'SKIPPED', skipReason: 'upstream_failed' },
    ]);
    expect(actions.dispatch).toEqual(['docs']);
    expect(actions.runStatus).toBe('RUNNING');
  });

  it('fails the run once the surviving branch finishes', () => {
    const actions = decide(
      chain,
      states({
        build: failed('b1'),
        test: { tableStatus: 'SKIPPED', skipReason: 'upstream_failed' },
        deploy: { tableStatus: 'SKIPPED', skipReason: 'upstream_failed' },
        docs: succeeded('b2'),
      }),
      false,
      CLOCK,
    );
    expect(actions.runStatus).toBe('FAILED');
    expect(actions.dispatch).toEqual([]);
  });

  it('treats skip_if skips as success-like for dependents and for the run', () => {
    const wf = workflow([{ name: 'guard' }, { name: 'after', dependsOn: ['guard'] }]);
    const guarded = states({
      guard: { tableStatus: 'SKIPPED', skipReason: 'skip_if' },
      after: succeeded('b1'),
    });
    expect(decide(wf, guarded, false, CLOCK).runStatus).toBe('SUCCEEDED');
    expect(
      decide(wf, states({ guard: { tableStatus: 'SKIPPED', skipReason: 'skip_if' } }), false, CLOCK)
        .dispatch,
    ).toEqual(['after']);
  });

  it('skips jobs depending on names the model does not define (fail closed)', () => {
    const wf = workflow([{ name: 'a', dependsOn: ['ghost'] }]);
    const actions = decide(wf, {}, false, CLOCK);
    expect(actions.markJobs).toEqual([
      { job: 'a', status: 'SKIPPED', skipReason: 'upstream_failed' },
    ]);
    expect(actions.runStatus).toBe('FAILED');
  });
});

describe('decide — CodeBuild ground truth is authoritative', () => {
  it('a poisoned SUCCEEDED job row never unblocks dependents whose build failed', () => {
    const wf = workflow([{ name: 'build' }, { name: 'deploy', dependsOn: ['build'] }]);
    const poisoned = states({
      build: { attempts: 1, buildId: 'b1', buildOutcome: 'FAILED', tableStatus: 'SUCCEEDED' },
    });
    const actions = decide(wf, poisoned, false, CLOCK);
    expect(actions.dispatch).toEqual([]);
    expect(actions.markJobs).toContainEqual({
      job: 'deploy',
      status: 'SKIPPED',
      skipReason: 'upstream_failed',
    });
    expect(actions.runStatus).toBe('FAILED');
  });

  it('a SUCCEEDED row without a build or rerun seed is not believed', () => {
    const wf = workflow([{ name: 'build' }, { name: 'deploy', dependsOn: ['build'] }]);
    const actions = decide(wf, states({ build: { tableStatus: 'SUCCEEDED' } }), false, CLOCK);
    expect(actions.dispatch).toEqual(['build']);
    expect(actions.runStatus).toBe('RUNNING');
  });

  it('rerun-seeded successes (reusedFrom) satisfy dependents without a build', () => {
    const wf = workflow([{ name: 'build' }, { name: 'deploy', dependsOn: ['build'] }]);
    const seeded = states({
      build: { tableStatus: 'SUCCEEDED', reusedFrom: 'octo/app#ci#41' },
    });
    expect(decide(wf, seeded, false, CLOCK).dispatch).toEqual(['deploy']);
  });

  it('a build killed out of band converges the job to CANCELLED and the run to FAILED', () => {
    const wf = workflow([{ name: 'build' }, { name: 'deploy', dependsOn: ['build'] }]);
    const stopped = states({
      build: { attempts: 1, buildId: 'b1', buildOutcome: 'STOPPED', tableStatus: 'RUNNING' },
    });
    const actions = decide(wf, stopped, false, CLOCK);
    expect(actions.markJobs).toContainEqual({
      job: 'deploy',
      status: 'SKIPPED',
      skipReason: 'upstream_failed',
    });
    expect(actions.runStatus).toBe('FAILED');
  });
});

describe('decide — bounded retries', () => {
  const solo = workflow([{ name: 'build' }]);

  it('retries an infrastructure FAULT within the attempt cap', () => {
    const faulted = states({
      build: { attempts: 1, buildId: 'b1', buildOutcome: 'FAULT', tableStatus: 'RUNNING' },
    });
    expect(decide(solo, faulted, false, CLOCK).dispatch).toEqual(['build']);
  });

  it('fails the job and run once the default cap of 3 is exhausted', () => {
    const exhausted = states({
      build: { attempts: 3, buildId: 'b3', buildOutcome: 'FAULT', tableStatus: 'RUNNING' },
    });
    const actions = decide(solo, exhausted, false, CLOCK);
    expect(actions.dispatch).toEqual([]);
    expect(actions.markJobs).toEqual([{ job: 'build', status: 'FAILED' }]);
    expect(actions.runStatus).toBe('FAILED');
  });

  it('honors a model-overridden attempt cap', () => {
    const wf = workflow([{ name: 'build', attempts: 5 }]);
    const faulted = states({
      build: { attempts: 3, buildId: 'b3', buildOutcome: 'FAULT', tableStatus: 'RUNNING' },
    });
    expect(decide(wf, faulted, false, CLOCK).dispatch).toEqual(['build']);
  });

  it('never auto-retries a command FAILURE', () => {
    const actions = decide(solo, states({ build: failed('b1') }), false, CLOCK);
    expect(actions.dispatch).toEqual([]);
    expect(actions.runStatus).toBe('FAILED');
  });

  it('re-dispatches a stale dispatch claim but waits on a fresh one', () => {
    const fresh = states({ build: { attempts: 1, dispatchedAt: NOW - 10_000 } });
    expect(decide(solo, fresh, false, CLOCK).dispatch).toEqual([]);
    expect(decide(solo, fresh, false, CLOCK).runStatus).toBe('RUNNING');

    const stale = states({
      build: { attempts: 1, dispatchedAt: NOW - STALE_DISPATCH_MS - 1000 },
    });
    expect(decide(solo, stale, false, CLOCK).dispatch).toEqual(['build']);
  });
});

describe('decide — cancellation', () => {
  const wf = workflow([{ name: 'build' }, { name: 'test', dependsOn: ['build'] }]);

  it('stops in-flight builds, cancels live jobs, and cancels the run', () => {
    const actions = decide(wf, states({ build: running('b1') }), true, CLOCK);
    expect(actions.stopBuilds).toEqual([{ job: 'build', buildId: 'b1' }]);
    expect(actions.markJobs).toEqual([
      { job: 'build', status: 'CANCELLED' },
      { job: 'test', status: 'CANCELLED' },
    ]);
    expect(actions.dispatch).toEqual([]);
    expect(actions.runStatus).toBe('CANCELLED');
  });

  it('leaves already-terminal jobs untouched and stays idempotent', () => {
    const actions = decide(
      wf,
      states({ build: succeeded('b1'), test: { tableStatus: 'CANCELLED' } }),
      true,
      CLOCK,
    );
    expect(actions.stopBuilds).toEqual([]);
    expect(actions.markJobs).toEqual([]);
    expect(actions.runStatus).toBe('CANCELLED');
  });
});

describe('decide — run deadline', () => {
  const wf = workflow([{ name: 'build' }, { name: 'test', dependsOn: ['build'] }]);

  it('times out every live job and fails the run past the default 24 h deadline', () => {
    const anchor = NOW - (DEFAULT_RUN_DEADLINE_MINUTES * 60 * 1000 + 1);
    const actions = decide(wf, states({ build: running('b1') }), false, {
      nowMs: NOW,
      anchorMs: anchor,
    });
    expect(actions.stopBuilds).toEqual([{ job: 'build', buildId: 'b1' }]);
    expect(actions.markJobs).toEqual([
      { job: 'build', status: 'TIMED_OUT' },
      { job: 'test', status: 'TIMED_OUT' },
    ]);
    expect(actions.runStatus).toBe('FAILED');
  });

  it('keeps running inside the deadline, anchored to the original start', () => {
    const anchor = NOW - DEFAULT_RUN_DEADLINE_MINUTES * 60 * 1000 + 60_000;
    const actions = decide(wf, states({ build: running('b1') }), false, {
      nowMs: NOW,
      anchorMs: anchor,
    });
    expect(actions.runStatus).toBe('RUNNING');
    expect(actions.markJobs).toEqual([]);
  });

  it('honors a model override but clamps it to the 36 h CodeBuild ceiling', () => {
    const shortWf = workflow([{ name: 'build' }], 30);
    const past30m = { nowMs: NOW, anchorMs: NOW - 31 * 60 * 1000 };
    expect(decide(shortWf, states({ build: running('b1') }), false, past30m).runStatus).toBe(
      'FAILED',
    );

    const hugeWf = workflow([{ name: 'build' }], 10 * 24 * 60);
    const past36h = { nowMs: NOW, anchorMs: NOW - (MAX_RUN_DEADLINE_MINUTES + 1) * 60 * 1000 };
    expect(decide(hugeWf, states({ build: running('b1') }), false, past36h).runStatus).toBe(
      'FAILED',
    );
  });
});

describe('effectiveJobStatus', () => {
  const job = { name: 'build', steps: [{ run: 'true' }] };

  it('maps build phases and terminal outcomes', () => {
    expect(effectiveJobStatus(job, undefined, NOW)).toBe('PENDING');
    expect(
      effectiveJobStatus(job, { attempts: 1, buildId: 'b', buildOutcome: 'IN_PROGRESS' }, NOW),
    ).toBe('RUNNING');
    expect(
      effectiveJobStatus(job, { attempts: 1, buildId: 'b', buildOutcome: 'TIMED_OUT' }, NOW),
    ).toBe('TIMED_OUT');
    expect(
      effectiveJobStatus(job, { attempts: 1, buildId: 'b', buildOutcome: 'STOPPED' }, NOW),
    ).toBe('CANCELLED');
  });

  it('treats a build BatchGetBuilds cannot verify as a retryable fault', () => {
    expect(effectiveJobStatus(job, { attempts: 1, buildId: 'gone' }, NOW)).toBe('RETRYABLE');
    expect(effectiveJobStatus(job, { attempts: 3, buildId: 'gone' }, NOW)).toBe('FAILED');
  });

  it('trusts decider-authored terminal states without a build', () => {
    expect(effectiveJobStatus(job, { attempts: 0, tableStatus: 'CANCELLED' }, NOW)).toBe(
      'CANCELLED',
    );
    expect(effectiveJobStatus(job, { attempts: 0, tableStatus: 'TIMED_OUT' }, NOW)).toBe(
      'TIMED_OUT',
    );
    expect(
      effectiveJobStatus(
        job,
        { attempts: 0, tableStatus: 'SKIPPED', skipReason: 'upstream_failed' },
        NOW,
      ),
    ).toBe('SKIPPED');
  });
});
