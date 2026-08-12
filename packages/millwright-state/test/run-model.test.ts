import { describe, expect, it } from 'vitest';
import {
  DEFAULT_JOB_ATTEMPTS,
  DEFAULT_RUN_DEADLINE_MINUTES,
  MAX_RUN_DEADLINE_MINUTES,
  RunModelError,
  jobAttemptCap,
  jobDependencies,
  parseRunModel,
  runDeadlineMinutes,
  workflowFromModel,
} from '../src';

const MODEL = {
  schemaVersion: 1,
  repo: 'octo/app',
  sha: 'a'.repeat(40),
  workflows: [
    {
      name: 'ci',
      jobs: [
        { name: 'build', image: 'node:22', steps: ['npm ci', { run: 'npm test', name: 'test' }] },
        {
          name: 'deploy',
          image: 'node:22',
          steps: [{ run: './deploy.sh', skipIf: 'test -f .skip' }],
          dependsOn: ['build'],
          consumes: [{ job: 'build', artifact: 'dist' }],
          attempts: 5,
          timeoutMinutes: 30,
          env: { STAGE: 'prod', BAD: 42 },
        },
      ],
    },
  ],
};

describe('parseRunModel', () => {
  it('narrows a valid document, normalizing string steps and dropping non-string env', () => {
    const model = parseRunModel(MODEL);
    expect(model.repo).toBe('octo/app');
    const ci = workflowFromModel(model, 'ci');
    expect(ci.jobs[0].steps).toEqual([{ run: 'npm ci' }, { run: 'npm test', name: 'test' }]);
    expect(ci.jobs[1].steps[0].skipIf).toBe('test -f .skip');
    expect(ci.jobs[1].env).toEqual({ STAGE: 'prod' });
  });

  it('rejects documents missing required structure', () => {
    expect(() => parseRunModel(null)).toThrow(RunModelError);
    expect(() => parseRunModel({ repo: 'octo/app', workflows: [] })).toThrow(/schemaVersion/);
    expect(() => parseRunModel({ schemaVersion: 1, workflows: [] })).toThrow(/repo/);
    expect(() =>
      parseRunModel({ schemaVersion: 1, repo: 'octo/app', workflows: [{ name: 'ci' }] }),
    ).toThrow(/jobs/);
    expect(() =>
      parseRunModel({
        schemaVersion: 1,
        repo: 'octo/app',
        workflows: [{ name: 'ci', jobs: [{ name: 'x' }] }],
      }),
    ).toThrow(/uninterpretable job/);
  });

  it('workflowFromModel names the missing workflow', () => {
    const model = parseRunModel(MODEL);
    expect(() => workflowFromModel(model, 'release')).toThrow(/no workflow "release"/);
  });
});

describe('caps and defaults', () => {
  it('merges dependsOn and consumes into one dependency set', () => {
    const model = parseRunModel(MODEL);
    expect(jobDependencies(workflowFromModel(model, 'ci').jobs[1])).toEqual(['build']);
  });

  it('defaults and clamps the attempt cap', () => {
    const model = parseRunModel(MODEL);
    const [build, deploy] = workflowFromModel(model, 'ci').jobs;
    expect(jobAttemptCap(build)).toBe(DEFAULT_JOB_ATTEMPTS);
    expect(jobAttemptCap(deploy)).toBe(5);
    expect(jobAttemptCap({ name: 'x', steps: [], attempts: 0 })).toBe(DEFAULT_JOB_ATTEMPTS);
    expect(jobAttemptCap({ name: 'x', steps: [], attempts: 2.5 })).toBe(DEFAULT_JOB_ATTEMPTS);
  });

  it('defaults the deadline to 24 h and clamps overrides to 36 h', () => {
    expect(runDeadlineMinutes({ name: 'ci', jobs: [] })).toBe(DEFAULT_RUN_DEADLINE_MINUTES);
    expect(runDeadlineMinutes({ name: 'ci', jobs: [], deadlineMinutes: 60 })).toBe(60);
    expect(runDeadlineMinutes({ name: 'ci', jobs: [], deadlineMinutes: 99999 })).toBe(
      MAX_RUN_DEADLINE_MINUTES,
    );
    expect(runDeadlineMinutes({ name: 'ci', jobs: [], deadlineMinutes: -5 })).toBe(
      DEFAULT_RUN_DEADLINE_MINUTES,
    );
  });
});
