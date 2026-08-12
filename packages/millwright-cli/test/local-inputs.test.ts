import { describe, expect, it } from 'vitest';
import { CommandError } from '../src/config-plane';
import { declaredManualInputs, parseInputArgs, resolveLocalInputs } from '../src/local/local-inputs';

const DECLARED = {
  env: { type: 'choice', choices: ['staging', 'prod'] },
  region: { type: 'choice', choices: ['eu', 'us'], default: 'eu' },
  dryRun: { type: 'boolean', default: true },
} as const;

describe('parseInputArgs', () => {
  it('splits at the first = and rejects malformed or duplicate flags', () => {
    expect(parseInputArgs(['a=1', 'url=https://x?a=b'])).toEqual({ a: '1', url: 'https://x?a=b' });
    expect(() => parseInputArgs(['noequals'])).toThrow(CommandError);
    expect(() => parseInputArgs(['=v'])).toThrow(CommandError);
    expect(() => parseInputArgs(['a=1', 'a=2'])).toThrow(/more than once/);
  });
});

describe('resolveLocalInputs', () => {
  it('types booleans, passes choices through, and prompts only for required omissions', async () => {
    const prompts: string[] = [];
    const values = await resolveLocalInputs({
      workflow: 'deploy',
      raw: { dryRun: 'false' },
      declared: DECLARED,
      promptLine: async (question) => {
        prompts.push(question);
        return 'staging';
      },
    });
    // region has a default and dryRun was given — only env prompts.
    expect(prompts).toHaveLength(1);
    expect(values).toEqual({ dryRun: false, env: 'staging' });
  });

  it('rejects undeclared names, bad booleans and off-list prompt answers', async () => {
    await expect(
      resolveLocalInputs({ workflow: 'deploy', raw: { nope: 'x' }, declared: DECLARED }),
    ).rejects.toThrow(/not declared/);
    await expect(
      resolveLocalInputs({ workflow: 'deploy', raw: { dryRun: 'yes', env: 'prod' }, declared: DECLARED }),
    ).rejects.toThrow(/must be true or false/);
    await expect(
      resolveLocalInputs({
        workflow: 'deploy',
        raw: {},
        declared: DECLARED,
        promptLine: async () => 'antarctica',
      }),
    ).rejects.toThrow(/must be one of staging, prod/);
  });

  it('refuses --input for workflows without a manual trigger', async () => {
    await expect(
      resolveLocalInputs({ workflow: 'ci', raw: { a: '1' }, declared: undefined }),
    ).rejects.toThrow(/declares no Trigger.manual/);
    expect(await resolveLocalInputs({ workflow: 'ci', raw: {}, declared: undefined })).toEqual({});
  });
});

describe('declaredManualInputs', () => {
  it('unions inputs across manual triggers and returns undefined without one', () => {
    expect(
      declaredManualInputs({
        name: 'wf',
        triggers: [
          { kind: 'push' },
          { kind: 'manual', inputs: { a: { type: 'boolean' } } },
          { kind: 'manual', inputs: { b: { type: 'choice', choices: ['x'] } } },
        ],
        jobs: [],
      }),
    ).toEqual({ a: { type: 'boolean' }, b: { type: 'choice', choices: ['x'] } });
    expect(
      declaredManualInputs({ name: 'wf', triggers: [{ kind: 'push' }], jobs: [] }),
    ).toBeUndefined();
  });
});
