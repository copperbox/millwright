import { describe, expect, it } from 'vitest';
import { executionArn, executionName, synthExecutionName } from '../src/execution-names';

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

describe('synthExecutionName', () => {
  const sha = 'c'.repeat(40);

  it('keys the bootstrap execution by (repo, ref, sha)', () => {
    const name = synthExecutionName('octocat/app', 'refs/heads/main', sha);
    expect(name).toBe(synthExecutionName('octocat/app', 'refs/heads/main', sha));
    expect(name).toMatch(/^synth-octocat-app-cccccccccccc-[0-9a-f]{12}$/);
    expect(name).not.toBe(synthExecutionName('octocat/app', 'refs/heads/dev', sha));
    expect(name).not.toBe(synthExecutionName('octocat/app', 'refs/heads/main', 'd'.repeat(40)));
  });
});

describe('executionArn', () => {
  it('addresses an execution of the named state machine', () => {
    expect(
      executionArn('arn:aws:states:eu-west-1:123456789012:stateMachine:prod-run-executor', 'synth-x-1'),
    ).toBe('arn:aws:states:eu-west-1:123456789012:execution:prod-run-executor:synth-x-1');
  });

  it('rejects anything that is not a state machine ARN', () => {
    expect(executionArn('prod-run-executor', 'synth-x-1')).toBeUndefined();
    expect(
      executionArn('arn:aws:states:eu-west-1:123456789012:execution:prod-run-executor:other', 'x'),
    ).toBeUndefined();
  });
});
