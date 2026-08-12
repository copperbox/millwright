import type { SFNClient } from '@aws-sdk/client-sfn';
import { RunItem, runKey, withMetadataTtl } from '@copperbox/millwright-state';
import { describe, expect, it } from 'vitest';
import { SfnExecutionStarter, executionName } from '../src/runtime/shared/executions';

const NOW = Date.parse('2026-08-12T06:00:00Z');

function fakeSfn(errors: Error[] = []): {
  client: SFNClient;
  inputs: Array<{ stateMachineArn: string; name: string; input: string }>;
} {
  const inputs: Array<{ stateMachineArn: string; name: string; input: string }> = [];
  const client = {
    send: async (command: { input: { stateMachineArn: string; name: string; input: string } }) => {
      const error = errors.shift();
      if (error) {
        throw error;
      }
      inputs.push(command.input);
      return {};
    },
  } as unknown as SFNClient;
  return { client, inputs };
}

function run(runNumber: number): RunItem {
  const coords = { repo: 'octocat/app', workflow: 'ci', runNumber };
  const createdAt = new Date(NOW).toISOString();
  return withMetadataTtl(
    {
      ...runKey(coords),
      ...coords,
      status: 'PENDING',
      trigger: 'push',
      ref: 'refs/heads/main',
      sha: 'c'.repeat(40),
      createdAt,
      originalStartedAt: createdAt,
    },
    NOW,
  );
}

describe('executionName', () => {
  it('is deterministic, charset-confined, and within the 80-char limit', () => {
    const name = executionName('run', 'octocat/app-ci-142', 'octocat/app#ci#142');
    expect(name).toBe(executionName('run', 'octocat/app-ci-142', 'octocat/app#ci#142'));
    expect(name).toMatch(/^run-[A-Za-z0-9_-]+$/);
    expect(name.length).toBeLessThanOrEqual(80);
  });

  it('stays within the limit and unique for hostile lengths', () => {
    const a = executionName('synth', 'x'.repeat(200), 'uniq-a');
    const b = executionName('synth', 'x'.repeat(200), 'uniq-b');
    expect(a.length).toBeLessThanOrEqual(80);
    expect(a).not.toBe(b);
  });
});

describe('SfnExecutionStarter', () => {
  it('starts a run execution with the pinned input contract', async () => {
    const { client, inputs } = fakeSfn();
    const starter = new SfnExecutionStarter(client, 'arn:sm', () => {});
    await starter.startRun(run(142));
    expect(inputs).toHaveLength(1);
    expect(inputs[0].stateMachineArn).toBe('arn:sm');
    expect(inputs[0].name).toMatch(/^run-octocat-app-ci-142-[0-9a-f]{12}$/);
    expect(JSON.parse(inputs[0].input)).toEqual({
      action: 'run',
      runId: 'octocat/app#ci#142',
      repo: 'octocat/app',
      workflow: 'ci',
      runNumber: 142,
      ref: 'refs/heads/main',
      sha: 'c'.repeat(40),
      trigger: 'push',
    });
  });

  it('starts rerun runs with resume: true — reruns never re-synth', async () => {
    const { client, inputs } = fakeSfn();
    const starter = new SfnExecutionStarter(client, 'arn:sm', () => {});
    await starter.startRun({ ...run(43), trigger: 'rerun', rerunOf: 'octocat/app#ci#42' });
    expect(JSON.parse(inputs[0].input)).toMatchObject({
      action: 'run',
      runId: 'octocat/app#ci#43',
      trigger: 'rerun',
      resume: true,
    });
  });

  it('starts a synth-only execution keyed by (repo, ref, sha)', async () => {
    const { client, inputs } = fakeSfn();
    const starter = new SfnExecutionStarter(client, 'arn:sm', () => {});
    await starter.startSynthOnly('octocat/app', 'refs/heads/main', 'c'.repeat(40));
    expect(JSON.parse(inputs[0].input)).toEqual({
      action: 'synth-only',
      repo: 'octocat/app',
      ref: 'refs/heads/main',
      sha: 'c'.repeat(40),
    });
    // Same identity → same deterministic name.
    await starter.startSynthOnly('octocat/app', 'refs/heads/main', 'c'.repeat(40));
    expect(inputs[1].name).toBe(inputs[0].name);
  });

  it('treats ExecutionAlreadyExists as already-started and rethrows anything else', async () => {
    const already = Object.assign(new Error('exists'), { name: 'ExecutionAlreadyExists' });
    const { client } = fakeSfn([already]);
    const starter = new SfnExecutionStarter(client, 'arn:sm', () => {});
    await expect(starter.startRun(run(1))).resolves.toBeUndefined();

    const broken = fakeSfn([new Error('throttled')]);
    const failing = new SfnExecutionStarter(broken.client, 'arn:sm', () => {});
    await expect(failing.startRun(run(1))).rejects.toThrow('throttled');
  });
});
