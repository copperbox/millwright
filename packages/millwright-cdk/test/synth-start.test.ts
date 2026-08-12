import { describe, expect, it } from 'vitest';
import {
  BOOTSTRAP_WORKFLOW_SEGMENT,
  bootstrapInputPrefix,
  synthDestinationPrefix,
} from '../src/runtime/shared/synth-locations';
import {
  ExecutionInputError,
  parseExecutionInput,
} from '../src/runtime/shared/execution-input';
import { SYNTH_IMAGE, SYNTH_IMAGE_TAG } from '../src/synth-image';
import {
  StartedBuild,
  SynthBuildStartInput,
  SynthPhaseConfig,
  SynthPhaseEvent,
  renderSynthBuildspec,
  startSynthBuild,
} from '../src/runtime/synth/synth';

const CONFIG: SynthPhaseConfig = {
  deploymentName: 'millwright',
  projectName: 'millwright-builds',
  synthRoleArn: 'arn:aws:iam::123456789012:role/millwright-synth-job',
  artifactBucketName: 'millwright-artifacts',
  toolsBucketName: 'cdk-assets',
  toolsObjectKey: 'abc123.zip',
  schemaCeiling: 1,
  pollCadenceMinutes: 1,
};

const RUN_INPUT = {
  action: 'run' as const,
  runId: 'octocat/app#ci#7',
  repo: 'octocat/app',
  workflow: 'ci',
  runNumber: 7,
  ref: 'refs/heads/main',
  sha: 'a'.repeat(40),
  trigger: 'push',
};

const BOOTSTRAP_INPUT = {
  action: 'synth-only' as const,
  repo: 'octocat/app',
  ref: 'refs/heads/main',
  sha: 'b'.repeat(40),
};

function event(input: unknown): SynthPhaseEvent {
  return { taskToken: 'tok-123', input } as SynthPhaseEvent;
}

describe('execution input contract', () => {
  it('accepts the launcher run shape', () => {
    expect(parseExecutionInput(RUN_INPUT)).toEqual(RUN_INPUT);
  });

  it('accepts the bootstrap synth-only shape', () => {
    expect(parseExecutionInput(BOOTSTRAP_INPUT)).toEqual(BOOTSTRAP_INPUT);
  });

  it('rejects anything else loudly', () => {
    expect(() => parseExecutionInput({ action: 'run', repo: 'octocat/app' })).toThrowError(
      ExecutionInputError,
    );
    expect(() => parseExecutionInput(undefined)).toThrowError(ExecutionInputError);
    expect(() => parseExecutionInput({ action: 'other' })).toThrowError(ExecutionInputError);
  });
});

describe('synth destinations', () => {
  it('run executions land at the run in/ prefix', () => {
    expect(synthDestinationPrefix(RUN_INPUT)).toBe('runs/octocat/app/ci/7/in/');
  });

  it('bootstrap executions land at a sha-keyed prefix outside any workflow namespace', () => {
    expect(synthDestinationPrefix(BOOTSTRAP_INPUT)).toBe(
      `runs/octocat/app/${BOOTSTRAP_WORKFLOW_SEGMENT}/${'b'.repeat(40)}/in/`,
    );
    // The segment can never collide with a real workflow: model workflow
    // names must start with an alphanumeric.
    expect(BOOTSTRAP_WORKFLOW_SEGMENT.startsWith('.')).toBe(true);
  });

  it('rejects malformed coordinates instead of building a traversal-y key', () => {
    expect(() => bootstrapInputPrefix('octocat/app', '../escape')).toThrow();
    expect(() => bootstrapInputPrefix('not-a-repo', 'c'.repeat(40))).toThrow();
  });
});

describe('the pinned synth image', () => {
  it('is the full node:22 variant pinned by digest (spec §7.2)', () => {
    expect(SYNTH_IMAGE).toMatch(/^public\.ecr\.aws\/docker\/library\/node@sha256:[0-9a-f]{64}$/);
    expect(SYNTH_IMAGE_TAG).toBe('22');
  });
});

describe('startSynthBuild', () => {
  function starter() {
    const calls: SynthBuildStartInput[] = [];
    return {
      calls,
      start: async (input: SynthBuildStartInput): Promise<StartedBuild> => {
        calls.push(input);
        return { buildId: 'millwright-builds:uuid', buildArn: 'arn:...:build/millwright-builds:uuid' };
      },
    };
  }

  it('starts the synth build on the shared project with every pinned override', async () => {
    const s = starter();
    await startSynthBuild({ config: CONFIG, start: s.start }, event(RUN_INPUT));
    expect(s.calls).toHaveLength(1);
    const call = s.calls[0];
    expect(call.projectName).toBe('millwright-builds');
    expect(call.serviceRoleOverride).toBe(CONFIG.synthRoleArn);
    expect(call.imageOverride).toBe(SYNTH_IMAGE);
    expect(call.environmentTypeOverride).toBe('ARM_CONTAINER');
    expect(call.computeTypeOverride).toBe('BUILD_GENERAL1_SMALL');
    expect(call.privilegedModeOverride).toBe(false);
    expect(call.imagePullCredentialsTypeOverride).toBe('CODEBUILD');
    expect(call.sourceTypeOverride).toBe('S3');
    expect(call.sourceLocationOverride).toBe('cdk-assets/abc123.zip');
  });

  it('carries the task token and the full env contract for the tool', async () => {
    const s = starter();
    await startSynthBuild({ config: CONFIG, start: s.start }, event(RUN_INPUT));
    const env = Object.fromEntries(
      s.calls[0].environmentVariablesOverride.map(
        (v) => [v.name, v],
      ),
    );
    expect(env.MILLWRIGHT_TASK_TOKEN).toMatchObject({ value: 'tok-123', type: 'PLAINTEXT' });
    expect(env.MILLWRIGHT_REPO.value).toBe('octocat/app');
    expect(env.MILLWRIGHT_REF.value).toBe('refs/heads/main');
    expect(env.MILLWRIGHT_SHA.value).toBe('a'.repeat(40));
    expect(env.MILLWRIGHT_DEST_BUCKET.value).toBe('millwright-artifacts');
    expect(env.MILLWRIGHT_DEST_PREFIX.value).toBe('runs/octocat/app/ci/7/in/');
    expect(env.MILLWRIGHT_SCHEMA_CEILING.value).toBe('1');
    expect(env.MILLWRIGHT_POLL_CADENCE_MINUTES.value).toBe('1');
    // Secrets never ride the StartBuild call: the deploy key, host-key pins
    // and repo config resolve inside the build via PARAMETER_STORE under the
    // synth job role.
    expect(env.MILLWRIGHT_DEPLOY_KEY).toMatchObject({
      type: 'PARAMETER_STORE',
      value: '/millwright/millwright/repos/octocat/app/deploy-key',
    });
    expect(env.MILLWRIGHT_HOST_KEYS).toMatchObject({
      type: 'PARAMETER_STORE',
      value: '/millwright/millwright/github/host-keys',
    });
    expect(env.MILLWRIGHT_REPO_CONFIG).toMatchObject({
      type: 'PARAMETER_STORE',
      value: '/millwright/millwright/repos/octocat/app/config',
    });
  });

  it('bootstrap executions target the bootstrap prefix', async () => {
    const s = starter();
    await startSynthBuild({ config: CONFIG, start: s.start }, event(BOOTSTRAP_INPUT));
    const env = Object.fromEntries(
      s.calls[0].environmentVariablesOverride.map((v) => [
        v.name,
        v.value,
      ]),
    );
    expect(env.MILLWRIGHT_DEST_PREFIX).toBe(
      `runs/octocat/app/${BOOTSTRAP_WORKFLOW_SEGMENT}/${'b'.repeat(40)}/in/`,
    );
  });

  it('renders a buildspec that only runs the control plane tool', () => {
    const spec = JSON.parse(renderSynthBuildspec());
    expect(spec.version).toBe('0.2');
    expect(spec.phases.build.commands).toHaveLength(1);
    expect(spec.phases.build.commands[0]).toContain('synth-job.bundle.js');
  });

  it('a malformed execution input throws before any build starts', async () => {
    const s = starter();
    await expect(
      startSynthBuild({ config: CONFIG, start: s.start }, event({ action: 'run' })),
    ).rejects.toThrowError(ExecutionInputError);
    expect(s.calls).toHaveLength(0);
  });
});
