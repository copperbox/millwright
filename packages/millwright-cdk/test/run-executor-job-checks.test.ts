import {
  JobStatus,
  RunModelWorkflow,
  StepItem,
  cloudWatchLogLink,
  stepKey,
} from '@copperbox/millwright-state';
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
const LOGS = { region: 'eu-west-1', logGroup: '/millwright/ci/builds' };

function plan(overrides: Partial<JobCheckPlanInput>) {
  return planJobCheckWrites({
    coords: COORDS,
    sha: SHA,
    workflow: WORKFLOW,
    sequence: 4,
    checked: new Map(),
    after: new Map(),
    steps: [],
    logStreams: new Map(),
    firstIteration: false,
    terminal: false,
    ...overrides,
  });
}

const statuses = (entries: [string, JobStatus][]) => new Map<string, JobStatus>(entries);
const phases = (planned: ReturnType<typeof plan>) =>
  planned.map((p) => [p.write.context, p.write.desired.status]);
const conclusions = (planned: ReturnType<typeof plan>) =>
  planned.map((p) => [p.write.context, p.write.desired.conclusion]);

describe('planJobCheckWrites (spec §13.2 lifecycle, #51)', () => {
  it('opens every row-less job queued on the first iteration, in_progress where it dispatched', () => {
    const planned = plan({ firstIteration: true, after: statuses([['build', 'QUEUED']]) });
    expect(phases(planned)).toEqual([
      ['ci / build', 'in_progress'],
      ['ci / test', 'queued'],
    ]);
    expect(planned[0]).toMatchObject({ job: 'build', status: 'QUEUED' });
    expect(planned[1]).toMatchObject({ job: 'test', status: 'PENDING' });
    expect(planned[0].write).toMatchObject({
      repo: 'octo/app',
      sha: SHA,
      ownerRun: 'ci#7',
      ownerRunNumber: 7,
      ownerSequence: 4,
    });
  });

  it('leaves row-less jobs alone on later iterations — they are still queued', () => {
    expect(
      plan({ checked: statuses([['build', 'RUNNING']]), after: statuses([['build', 'RUNNING']]) }),
    ).toEqual([]);
  });

  it('writes only phase changes: QUEUED → RUNNING is not one, RUNNING → SUCCEEDED is', () => {
    expect(
      plan({ checked: statuses([['build', 'QUEUED']]), after: statuses([['build', 'RUNNING']]) }),
    ).toEqual([]);
    const planned = plan({
      checked: statuses([['build', 'RUNNING']]),
      after: statuses([['build', 'SUCCEEDED']]),
    });
    expect(conclusions(planned)).toEqual([['ci / build', 'success']]);
    expect(planned[0]).toMatchObject({ job: 'build', status: 'SUCCEEDED' });
  });

  it('compares against what the check last reflected, not a start-of-iteration snapshot', () => {
    // The build-events handler projected SUCCEEDED onto the row before this
    // iteration read it: the row says SUCCEEDED throughout, but the check
    // still shows in_progress (checked = QUEUED) and must be completed now.
    const planned = plan({
      checked: statuses([['build', 'QUEUED']]),
      after: statuses([
        ['build', 'SUCCEEDED'],
        ['test', 'QUEUED'],
      ]),
    });
    expect(conclusions(planned)).toEqual([
      ['ci / build', 'success'],
      ['ci / test', undefined],
    ]);
    expect(phases(planned)[1]).toEqual(['ci / test', 'in_progress']);
    // Once marked, the same rows are quiet on the next re-entry.
    expect(
      plan({
        checked: statuses([
          ['build', 'SUCCEEDED'],
          ['test', 'QUEUED'],
        ]),
        after: statuses([
          ['build', 'SUCCEEDED'],
          ['test', 'RUNNING'],
        ]),
      }),
    ).toEqual([]);
  });

  it('writes every job when the run goes terminal, even unchanged ones', () => {
    const final = statuses([
      ['build', 'FAILED'],
      ['test', 'SKIPPED'],
    ]);
    const planned = plan({ checked: final, after: final, terminal: true });
    expect(conclusions(planned)).toEqual([
      ['ci / build', 'failure'],
      ['ci / test', 'skipped'],
    ]);
  });

  it('renders the job’s steps in index order with durations, and a repo-qualified triage command on failure', () => {
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
      checked: statuses([['build', 'RUNNING']]),
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
    const lines = build.write.desired.summary.split('\n');
    const rows = lines.filter(
      (l: string) => l.startsWith('| ') && l !== '| step | result | duration |' && !l.startsWith('| ---'),
    );
    expect(rows).toEqual([
      '| install | SUCCEEDED | 1m 1s |',
      '| test | FAILED | — |',
      '| step 3 | SKIPPED | — |',
    ]);
    expect(build.write.desired.summary).not.toContain('elsewhere');
    // `ci#7` alone is ambiguous to the CLI when two watched repos define `ci`.
    expect(build.write.desired.summary).toContain('millwright logs octo/app/ci#7 --job build');
    expect(build.write.desired).toMatchObject({ status: 'completed', conclusion: 'timed_out' });
  });

  it('deep-links the check to the build’s CloudWatch stream once it is known', () => {
    const planned = plan({
      checked: statuses([['build', 'RUNNING']]),
      after: statuses([['build', 'FAILED']]),
      logStreams: new Map([['build', 'abc123/build-1']]),
      logs: LOGS,
    });
    expect(planned[0].write.desired.detailsUrl).toBe(
      cloudWatchLogLink('eu-west-1', '/millwright/ci/builds', 'abc123/build-1'),
    );

    // No stream yet (nothing to link) or no log location (PAT-only deployment
    // without the env): the check carries no details URL rather than a broken one.
    const noStream = plan({ after: statuses([['build', 'QUEUED']]), firstIteration: true, logs: LOGS });
    expect(noStream.map((p) => p.write.desired.detailsUrl)).toEqual([undefined, undefined]);
    const noLogs = plan({
      checked: statuses([['build', 'RUNNING']]),
      after: statuses([['build', 'FAILED']]),
      logStreams: new Map([['build', 'abc123/build-1']]),
    });
    expect(noLogs[0].write.desired.detailsUrl).toBeUndefined();
  });
});
