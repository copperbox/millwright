import type { CodeBuildClient, StartBuildCommandInput } from '@aws-sdk/client-codebuild';
import { RunModelJob, renderJobBuildspec } from '@copperbox/millwright-state';
import { describe, expect, it } from 'vitest';
import { CodeBuildRunner, toBuildOutcome } from '../src/runtime/run-executor/codebuild';
import { DispatchContext } from '../src/runtime/run-executor/iteration';

const CTX: DispatchContext = {
  coords: { repo: 'octo/app', workflow: 'ci', runNumber: 7 },
  runId: 'octo/app#ci#7',
  sha: 'a'.repeat(40),
  ref: 'refs/heads/main',
};

const JOB: RunModelJob = {
  name: 'build',
  image: 'public.ecr.aws/docker/library/node:22',
  steps: [{ run: 'make' }],
};

/** Captures StartBuild inputs and answers with the given result. */
function stubRunner(
  response: unknown = {
    build: { id: 'ci-builds:1234', arn: 'arn:aws:codebuild:build/ci-builds:1234' },
  },
): { runner: CodeBuildRunner; started: StartBuildCommandInput[] } {
  const started: StartBuildCommandInput[] = [];
  const client = {
    send: async (command: { input: StartBuildCommandInput }) => {
      started.push(command.input);
      return response;
    },
  } as unknown as CodeBuildClient;
  return {
    runner: new CodeBuildRunner(client, {
      projectName: 'ci-builds',
      bucketName: 'bkt',
      deploymentName: 'ci',
      eventBusName: 'ci-bus',
    }),
    started,
  };
}

describe('per-job dispatch overrides (spec §7.4)', () => {
  it('dispatches onto the single project with the shared renderer buildspec inline', async () => {
    const { runner, started } = stubRunner();
    await runner.start(JOB, CTX);
    const [input] = started;
    expect(input.projectName).toBe('ci-builds');
    expect(input.buildspecOverride).toBe(
      renderJobBuildspec(JOB, { deploymentName: 'ci', repo: 'octo/app' }),
    );
  });

  it('sources the run in/ prefix as primary and the shim as secondary', async () => {
    const { runner, started } = stubRunner();
    await runner.start(JOB, CTX);
    const [input] = started;
    expect(input.sourceTypeOverride).toBe('S3');
    expect(input.sourceLocationOverride).toBe('bkt/runs/octo/app/ci/7/in/');
    expect(input.secondarySourcesOverride).toEqual([
      { type: 'S3', location: 'bkt/control/shim/', sourceIdentifier: 'shim' },
    ]);
  });

  it('always pulls with SERVICE_ROLE credentials — job-role ECR grants are inert otherwise', async () => {
    const { runner, started } = stubRunner();
    await runner.start(JOB, CTX);
    expect(started[0].imagePullCredentialsTypeOverride).toBe('SERVICE_ROLE');
  });

  it('defaults to ARM small and maps the x86 opt-in to LINUX_CONTAINER', async () => {
    const { runner, started } = stubRunner();
    await runner.start(JOB, CTX);
    await runner.start({ ...JOB, compute: { arch: 'x86_64', size: 'large' } }, CTX);
    expect(started[0].environmentTypeOverride).toBe('ARM_CONTAINER');
    expect(started[0].computeTypeOverride).toBe('BUILD_GENERAL1_SMALL');
    expect(started[1].environmentTypeOverride).toBe('LINUX_CONTAINER');
    expect(started[1].computeTypeOverride).toBe('BUILD_GENERAL1_LARGE');
  });

  it('passes image, privileged mode and timeout through per job', async () => {
    const { runner, started } = stubRunner();
    await runner.start({ ...JOB, privileged: true, timeoutMinutes: 30 }, CTX);
    const [input] = started;
    expect(input.imageOverride).toBe('public.ecr.aws/docker/library/node:22');
    expect(input.privilegedModeOverride).toBe(true);
    expect(input.timeoutInMinutesOverride).toBe(30);
  });

  it('overrides the service role only when the dispatch names one', async () => {
    const { runner, started } = stubRunner();
    await runner.start(JOB, CTX);
    await runner.start(JOB, { ...CTX, serviceRoleArn: 'arn:aws:iam::1:role/mw-job' });
    expect(started[0].serviceRoleOverride).toBeUndefined();
    expect(started[1].serviceRoleOverride).toBe('arn:aws:iam::1:role/mw-job');
  });

  it('injects identity and data-plane env, then declared env minus reserved names', async () => {
    const { runner, started } = stubRunner();
    await runner.start(
      { ...JOB, env: { STAGE: 'prod', MILLWRIGHT_JOB: 'forged', AWS_REGION: 'evil' } },
      CTX,
    );
    const env = Object.fromEntries(
      (started[0].environmentVariablesOverride ?? []).map((entry) => [entry.name, entry.value]),
    );
    expect(env).toEqual({
      MILLWRIGHT_RUN_ID: 'octo/app#ci#7',
      MILLWRIGHT_JOB: 'build',
      MILLWRIGHT_SHA: 'a'.repeat(40),
      MILLWRIGHT_REF: 'refs/heads/main',
      MILLWRIGHT_EVENT_BUS: 'ci-bus',
      MILLWRIGHT_OUT_URI: 's3://bkt/runs/octo/app/ci/7/out',
      MILLWRIGHT_CACHE_URI: 's3://bkt/cache/octo/app',
      STAGE: 'prod',
    });
  });

  it('refuses a StartBuild answer without a build id', async () => {
    const { runner } = stubRunner({});
    await expect(runner.start(JOB, CTX)).rejects.toThrow(/no build id/);
  });
});

describe('toBuildOutcome', () => {
  it('passes known statuses through and treats the unknown as FAULT', () => {
    expect(toBuildOutcome('SUCCEEDED')).toBe('SUCCEEDED');
    expect(toBuildOutcome('STOPPED')).toBe('STOPPED');
    expect(toBuildOutcome('SOMETHING_NEW')).toBe('FAULT');
    expect(toBuildOutcome(undefined)).toBe('FAULT');
  });
});
