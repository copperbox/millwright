import { StepEventDetail } from '@copperbox/millwright-state';
import { describe, expect, it } from 'vitest';
import { UNIMPLEMENTED_EXIT_CODE, USAGE_EXIT_CODE, parseCli } from '../src/runtime/shim/cli';
import {
  CommandRunner,
  ShimDeps,
  StepEventEmitter,
  StepIdentity,
  runStep,
} from '../src/runtime/shim/shim';
import { main } from '../src/runtime/shim/main';

const IDENTITY: StepIdentity = { runId: 'octo/app#ci#7', job: 'build' };

class ScriptedRunner implements CommandRunner {
  readonly commands: string[] = [];
  constructor(private readonly exits: Array<number | Error>) {}

  async run(command: string): Promise<number> {
    this.commands.push(command);
    const next = this.exits.shift();
    if (next === undefined) {
      throw new Error('unexpected command');
    }
    if (next instanceof Error) {
      throw next;
    }
    return next;
  }
}

class MemoryEmitter implements StepEventEmitter {
  readonly emitted: StepEventDetail[] = [];
  failWith?: Error;

  async emit(detail: StepEventDetail): Promise<void> {
    if (this.failWith) {
      throw this.failWith;
    }
    this.emitted.push(detail);
  }
}

function deps(
  runner: ScriptedRunner,
  emitter = new MemoryEmitter(),
): { deps: ShimDeps; emitter: MemoryEmitter; warnings: string[] } {
  const warnings: string[] = [];
  let tick = 0;
  return {
    emitter,
    warnings,
    deps: {
      runner,
      emitter,
      // Deterministic clock: each look advances one second.
      clock: () => Date.parse('2026-08-12T06:00:00Z') + 1000 * tick++,
      warn: (message) => warnings.push(message),
    },
  };
}

describe('runStep', () => {
  it('reports start and success around a passing step and exits 0', async () => {
    const runner = new ScriptedRunner([0]);
    const { deps: d, emitter } = deps(runner);
    const code = await runStep(d, IDENTITY, { index: 0, name: 'compile', command: 'make' });

    expect(code).toBe(0);
    expect(runner.commands).toEqual(['make']);
    expect(emitter.emitted).toEqual([
      {
        runId: 'octo/app#ci#7',
        job: 'build',
        stepIndex: 0,
        name: 'compile',
        status: 'RUNNING',
        startedAt: '2026-08-12T06:00:00.000Z',
      },
      {
        runId: 'octo/app#ci#7',
        job: 'build',
        stepIndex: 0,
        name: 'compile',
        status: 'SUCCEEDED',
        startedAt: '2026-08-12T06:00:00.000Z',
        finishedAt: '2026-08-12T06:00:01.000Z',
      },
    ]);
  });

  it('reports FAILED and propagates the exit code on a failing step', async () => {
    const runner = new ScriptedRunner([3]);
    const { deps: d, emitter } = deps(runner);
    const code = await runStep(d, IDENTITY, { index: 2, command: 'false' });

    expect(code).toBe(3);
    expect(emitter.emitted.map((e) => e.status)).toEqual(['RUNNING', 'FAILED']);
  });

  it('skips on a passing skipIf guard: SKIPPED with reason skip_if, exit 0, no step run', async () => {
    const runner = new ScriptedRunner([0]);
    const { deps: d, emitter } = deps(runner);
    const code = await runStep(d, IDENTITY, {
      index: 1,
      skipIf: 'test -f skip-marker',
      command: 'make deploy',
    });

    expect(code).toBe(0);
    expect(runner.commands).toEqual(['test -f skip-marker']);
    expect(emitter.emitted).toHaveLength(1);
    expect(emitter.emitted[0]).toMatchObject({
      status: 'SKIPPED',
      reason: 'skip_if',
      stepIndex: 1,
      startedAt: '2026-08-12T06:00:00.000Z',
      finishedAt: '2026-08-12T06:00:01.000Z',
    });
  });

  it('runs the step when the skipIf guard fails', async () => {
    const runner = new ScriptedRunner([1, 0]);
    const { deps: d, emitter } = deps(runner);
    const code = await runStep(d, IDENTITY, {
      index: 1,
      skipIf: 'test -f skip-marker',
      command: 'make deploy',
    });

    expect(code).toBe(0);
    expect(runner.commands).toEqual(['test -f skip-marker', 'make deploy']);
    expect(emitter.emitted.map((e) => e.status)).toEqual(['RUNNING', 'SUCCEEDED']);
  });

  it('runs the step when the skipIf guard cannot even spawn, with a warning', async () => {
    const runner = new ScriptedRunner([new Error('spawn failed'), 0]);
    const { deps: d, warnings } = deps(runner);
    const code = await runStep(d, IDENTITY, { index: 0, skipIf: 'guard', command: 'make' });

    expect(code).toBe(0);
    expect(runner.commands).toEqual(['guard', 'make']);
    expect(warnings.join('\n')).toContain('skipIf guard could not run');
  });

  it('never fails the job over reporting: emitter outages warn and the exit code stands', async () => {
    const runner = new ScriptedRunner([0]);
    const emitter = new MemoryEmitter();
    emitter.failWith = new Error('PutEvents denied');
    const { deps: d, warnings } = deps(runner, emitter);
    const code = await runStep(d, IDENTITY, { index: 0, command: 'make' });

    expect(code).toBe(0);
    expect(warnings.filter((w) => w.includes('not reported'))).toHaveLength(2);
  });

  it('reports FAILED with exit 127 when the step command cannot spawn', async () => {
    const runner = new ScriptedRunner([new Error('ENOENT')]);
    const { deps: d, emitter } = deps(runner);
    const code = await runStep(d, IDENTITY, { index: 0, command: 'make' });

    expect(code).toBe(127);
    expect(emitter.emitted.map((e) => e.status)).toEqual(['RUNNING', 'FAILED']);
  });
});

describe('parseCli', () => {
  it('parses the renderer-authored step invocation', () => {
    expect(
      parseCli(['step', '--index', '2', '--name', 'compile', '--skip-if', 'test -f m', '--', 'make all']),
    ).toEqual({
      kind: 'step',
      spec: { index: 2, name: 'compile', skipIf: 'test -f m', command: 'make all' },
    });
  });

  it('parses a minimal step invocation', () => {
    expect(parseCli(['step', '--index', '0', '--', 'make'])).toEqual({
      kind: 'step',
      spec: { index: 0, name: undefined, skipIf: undefined, command: 'make' },
    });
  });

  it('rejects a missing or malformed index', () => {
    expect(parseCli(['step', '--', 'make'])).toMatchObject({ kind: 'error' });
    expect(parseCli(['step', '--index', 'two', '--', 'make'])).toMatchObject({ kind: 'error' });
    expect(parseCli(['step', '--index', '-1', '--', 'make'])).toMatchObject({ kind: 'error' });
    expect(parseCli(['step', '--index', '10000', '--', 'make'])).toMatchObject({ kind: 'error' });
  });

  it('rejects a missing command, dangling flag values and unknown flags', () => {
    expect(parseCli(['step', '--index', '0'])).toMatchObject({ kind: 'error' });
    expect(parseCli(['step', '--index', '0', '--'])).toMatchObject({ kind: 'error' });
    expect(parseCli(['step', '--index', '0', '--name'])).toMatchObject({ kind: 'error' });
    expect(parseCli(['step', '--index', '0', '--verbose', '--', 'make'])).toMatchObject({
      kind: 'error',
    });
    expect(parseCli([])).toMatchObject({ kind: 'error' });
  });

  it('flags renderer-known data-plane subcommands as unimplemented, not unknown', () => {
    expect(parseCli(['source', 'unpack', '--archive', 'source.tar.gz'])).toEqual({
      kind: 'unimplemented',
      command: 'source',
    });
    expect(parseCli(['artifact', 'fetch'])).toMatchObject({ kind: 'unimplemented' });
    expect(parseCli(['cache', 'restore'])).toMatchObject({ kind: 'unimplemented' });
    expect(parseCli(['bogus'])).toMatchObject({ kind: 'error' });
  });
});

describe('main', () => {
  const ENV = { MILLWRIGHT_RUN_ID: 'octo/app#ci#7', MILLWRIGHT_JOB: 'build' };

  function mainDeps(runner: ScriptedRunner, emitter = new MemoryEmitter()) {
    const warnings: string[] = [];
    return { warnings, deps: { warn: (m: string) => warnings.push(m), runner, emitter } };
  }

  it('exits with the usage code when the dispatch identity is missing', async () => {
    const { warnings, deps: d } = mainDeps(new ScriptedRunner([]));
    const code = await main(['step', '--index', '0', '--', 'make'], {}, d);
    expect(code).toBe(USAGE_EXIT_CODE);
    expect(warnings.join('\n')).toContain('MILLWRIGHT_RUN_ID');
  });

  it('exits with the usage code on argv errors without running anything', async () => {
    const runner = new ScriptedRunner([]);
    const { deps: d } = mainDeps(runner);
    expect(await main(['step', '--index', 'x', '--', 'make'], ENV, d)).toBe(USAGE_EXIT_CODE);
    expect(runner.commands).toHaveLength(0);
  });

  it('exits with the unimplemented code for data-plane subcommands', async () => {
    const { warnings, deps: d } = mainDeps(new ScriptedRunner([]));
    const code = await main(['cache', 'restore'], ENV, d);
    expect(code).toBe(UNIMPLEMENTED_EXIT_CODE);
    expect(warnings.join('\n')).toContain('not delivered');
  });

  it('runs a step end to end against injected deps', async () => {
    const runner = new ScriptedRunner([0]);
    const emitter = new MemoryEmitter();
    const { deps: d } = mainDeps(runner, emitter);
    const code = await main(['step', '--index', '0', '--', 'make'], ENV, d);
    expect(code).toBe(0);
    expect(emitter.emitted.map((e) => e.status)).toEqual(['RUNNING', 'SUCCEEDED']);
    expect(emitter.emitted[0].runId).toBe('octo/app#ci#7');
  });
});
