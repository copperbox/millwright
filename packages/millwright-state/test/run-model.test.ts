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

  it('narrows cache, produced artifacts and secret references', () => {
    const model = parseRunModel({
      schemaVersion: 1,
      repo: 'octo/app',
      workflows: [
        {
          name: 'ci',
          jobs: [
            {
              name: 'build',
              image: 'node:22',
              steps: ['npm ci'],
              cache: {
                key: 'npm-abc123',
                paths: ['node_modules'],
                restoreKeys: ['npm-', 42],
              },
              produces: [{ name: 'dist', paths: ['dist', 'build/lib'] }],
              secrets: {
                NPM_TOKEN: { parameter: 'npm-token' },
                SHARED: { parameter: 'db-url', scope: 'platform' },
                DOCKERHUB: { secretsManager: 'arn:aws:secretsmanager:us-east-1:1:secret:x' },
              },
            },
          ],
        },
      ],
    });
    const job = workflowFromModel(model, 'ci').jobs[0];
    expect(job.cache).toEqual({ key: 'npm-abc123', paths: ['node_modules'], restoreKeys: ['npm-'] });
    expect(job.produces).toEqual([{ name: 'dist', paths: ['dist', 'build/lib'] }]);
    expect(job.secrets).toEqual({
      NPM_TOKEN: { parameter: 'npm-token' },
      SHARED: { parameter: 'db-url', scope: 'platform' },
      DOCKERHUB: { secretsManager: 'arn:aws:secretsmanager:us-east-1:1:secret:x' },
    });
  });

  it('drops malformed cache, artifact and secret shapes rather than guessing', () => {
    const model = parseRunModel({
      schemaVersion: 1,
      repo: 'octo/app',
      workflows: [
        {
          name: 'ci',
          jobs: [
            {
              name: 'build',
              image: 'node:22',
              steps: ['npm ci'],
              // No key → uninterpretable → no cache at all (fail closed).
              cache: { paths: ['node_modules'] },
              produces: [{ name: 'dist' }, { name: 'ok', paths: ['out'] }, 'junk'],
              secrets: {
                GOOD: { parameter: 'npm-token' },
                EMPTY: {},
                WRONG: { parameter: 7 },
                STRINGY: 'not-a-ref',
              },
            },
          ],
        },
      ],
    });
    const job = workflowFromModel(model, 'ci').jobs[0];
    expect(job.cache).toBeUndefined();
    expect(job.produces).toEqual([{ name: 'ok', paths: ['out'] }]);
    expect(job.secrets).toEqual({ GOOD: { parameter: 'npm-token' } });
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
