import type { SFNClient } from '@aws-sdk/client-sfn';
import { DescribeExecutionCommand } from '@aws-sdk/client-sfn';
import { describe, expect, it } from 'vitest';
import {
  SfnExecutionInspector,
  carryOverExecutionName,
  runExecutionName,
} from '../src/runtime/shared/executions';

const MACHINE = 'arn:aws:states:eu-west-1:123456789012:stateMachine:ci-run-executor';

function fakeSfn(behavior: { status?: string; error?: string }): {
  client: SFNClient;
  arns: string[];
} {
  const arns: string[] = [];
  const client = {
    send: async (command: { input: { executionArn: string } }) => {
      expect(command).toBeInstanceOf(DescribeExecutionCommand);
      arns.push(command.input.executionArn);
      if (behavior.error) {
        throw Object.assign(new Error(behavior.error), { name: behavior.error });
      }
      return { status: behavior.status };
    },
  } as unknown as SFNClient;
  return { client, arns };
}

describe('SfnExecutionInspector', () => {
  it('describes the execution by machine-derived ARN and reports RUNNING as running', async () => {
    const { client, arns } = fakeSfn({ status: 'RUNNING' });
    const inspector = new SfnExecutionInspector(client, MACHINE);
    expect(await inspector.describe('run-octocat-app-ci-142-abcdef012345')).toBe('running');
    expect(arns).toEqual([
      'arn:aws:states:eu-west-1:123456789012:execution:ci-run-executor:run-octocat-app-ci-142-abcdef012345',
    ]);
  });

  it('reports every non-RUNNING status as closed', async () => {
    for (const status of ['SUCCEEDED', 'FAILED', 'TIMED_OUT', 'ABORTED']) {
      const inspector = new SfnExecutionInspector(fakeSfn({ status }).client, MACHINE);
      expect(await inspector.describe('x')).toBe('closed');
    }
  });

  it('reports a non-existent execution as missing and rethrows anything else', async () => {
    const missing = new SfnExecutionInspector(
      fakeSfn({ error: 'ExecutionDoesNotExist' }).client,
      MACHINE,
    );
    expect(await missing.describe('x')).toBe('missing');
    const denied = new SfnExecutionInspector(fakeSfn({ error: 'AccessDeniedException' }).client, MACHINE);
    await expect(denied.describe('x')).rejects.toThrow('AccessDeniedException');
  });

  it('rejects a non-machine ARN loudly instead of describing nonsense', async () => {
    const inspector = new SfnExecutionInspector(fakeSfn({}).client, 'arn:sm');
    await expect(inspector.describe('x')).rejects.toThrow(/Not a state machine ARN/);
  });
});

describe('run execution naming shared by the launcher, hand-off and sweep', () => {
  it('derives the launcher-pinned name from the run row alone', () => {
    const run = { repo: 'octocat/app', workflow: 'ci', runNumber: 142 } as never;
    expect(runExecutionName(run)).toMatch(/^run-octocat-app-ci-142-[0-9a-f]{12}$/);
    expect(runExecutionName(run)).toBe(runExecutionName(run));
  });

  it('chains carry-over names deterministically', () => {
    const first = carryOverExecutionName('run-octocat-app-ci-142-abcdef012345');
    expect(first).toMatch(/^co-[0-9a-f]{40}$/);
    expect(carryOverExecutionName(first)).not.toBe(first);
    expect(carryOverExecutionName(first)).toBe(carryOverExecutionName(first));
  });
});
