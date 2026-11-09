import { JobStatus, RunModelWorkflow, StepItem, stepKey } from '@copperbox/millwright-state';
import { describe, expect, it } from 'vitest';
import { JobCheckPlanInput, planJobCheckWrites } from '../src/runtime/run-executor/job-checks';

const COORDS = { repo: 'octo/app', workflow: 'ci', runNumber: 7 };
const SHA = 'a'.repeat(40);
const WORKFLOW: RunModelWorkflow = {
  name: 'ci',
  jobs: [
    { name: 'build', image: 'node:22', steps: [{ run: 'make' }] },
    { name: 'test', image: 'node:22', steps: [{ run: 'make test' }], dependsOn: ['build'] },
  ],
};

function plan(overrides: Partial<JobCheckPlanInput>) {
  return planJobCheckWrites({
    coords: COORDS,
    sha: SHA,
    workflow: WORKFLOW,
    before: new Map(),
    after: new Map(),
    steps: [],
    firstIteration: false,
    terminal: false,
    ...overrides,
  });
}

const statuses = (entries: [string, JobStatus][]) => new Map<string, JobStatus>(entries);

describe('planJobCheckWrites (spec §13.2 lifecycle, #51)', () => {
  it('opens every row-less job queued on the first iteration, in_progress where it dispatched', () => {
    const writes = plan({ firstIteration: true, after: statuses([['build', 'QUEUED']]) });
    expect(writes.map((w) => [w.context, w.desired.status])).toEqual([
      ['ci / build', 'in_progress'],
      ['ci / test', 'queued'],
    ]);
    expect(writes[0]).toMatchObject({ repo: 'octo/app', sha: SHA, ownerRun: 'ci#7', ownerRunNumber: 7 });
  });

  it('leaves row-less jobs alone on later iterations — they are still queued', () => {
    expect(plan({ before: statuses([['build', 'RUNNING']]), after: statuses([['build', 'RUNNING']]) })).toEqual([]);
  });

  it('writes only phase changes: QUEUED → RUNNING is not one, RUNNING → SUCCEEDED is', () => {
    expect(
      plan({ before: statuses([['build', 'QUEUED']]), after: statuses([['build', 'RUNNING']]) }),
    ).toEqual([]);
    const writes = plan({
      before: statuses([['build', 'RUNNING']]),
      after: statuses([['build', 'SUCCEEDED']]),
    });
    expect(writes.map((w) => [w.context, w.desired.conclusion])).toEqual([['ci / build', 'success']]);
  });

  it('writes every job when the run goes terminal, even unchanged ones', () => {
    const final = statuses([
      ['build', 'FAILED'],
      ['test', 'SKIPPED'],
    ]);
    const writes = plan({ before: final, after: final, terminal: true });
    expect(writes.map((w) => [w.context, w.desired.conclusion])).toEqual([
      ['ci / build', 'failure'],
      ['ci / test', 'skipped'],
    ]);
  });

  it('renders the job’s steps in index order with durations, and a triage command on failure', () => {
    const step = (job: string, index: number, extra: Partial<StepItem>): StepItem => ({
      ...stepKey(COORDS, job, index),
      ...COORDS,
      job,
      stepIndex: index,
      status: 'SUCCEEDED',
      expiresAt: 0,
      ...extra,
    });
    const t0 = Date.parse('2026-08-12T06:00:00Z');
    const [build] = plan({
      before: statuses([['build', 'RUNNING']]),
      after: statuses([['build', 'TIMED_OUT']]),
      steps: [
        step('build', 1, { name: 'test', status: 'FAILED' }),
        step('build', 0, {
          name: 'install',
          startedAt: new Date(t0).toISOString(),
          finishedAt: new Date(t0 + 61_000).toISOString(),
        }),
        step('test', 0, { name: 'elsewhere' }),
        step('build', 2, { status: 'SKIPPED' }),
      ],
    });
    const lines = build.desired.summary.split('\n');
    const rows = lines.filter((l) => l.startsWith('| ') && l !== '| step | result | duration |' && !l.startsWith('| ---'));
    expect(rows).toEqual([
      '| install | SUCCEEDED | 1m 1s |',
      '| test | FAILED | — |',
      '| step 3 | SKIPPED | — |',
    ]);
    expect(build.desired.summary).not.toContain('elsewhere');
    expect(build.desired.summary).toContain('millwright logs ci#7 --job build');
    expect(build.desired).toMatchObject({ status: 'completed', conclusion: 'timed_out' });
  });
});
