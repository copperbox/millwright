import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { STEP_EVENTS_FILE_ENV, StepEventDetail } from '@copperbox/millwright-state';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { main } from '../src/runtime/shim/main';

/**
 * The shim end to end on this host: real `/bin/sh` runner, real file sink —
 * the exact wiring a local `docker run` uses (the cloud differs only in the
 * sink, covered by the emitter tests).
 */
describe('shim integration (real shell, file sink)', () => {
  let dir: string;
  let eventsPath: string;
  let env: NodeJS.ProcessEnv;
  let warnings: string[];

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'shim-int-'));
    eventsPath = join(dir, 'events.jsonl');
    env = {
      MILLWRIGHT_RUN_ID: 'octo/app#ci#7',
      MILLWRIGHT_JOB: 'build',
      [STEP_EVENTS_FILE_ENV]: eventsPath,
    };
    warnings = [];
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  async function events(): Promise<StepEventDetail[]> {
    const raw = await readFile(eventsPath, 'utf8');
    return raw
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line).detail);
  }

  function run(argv: string[]): Promise<number> {
    return main(argv, env, { warn: (m) => warnings.push(m) });
  }

  it('reports start and success around a passing step', async () => {
    const code = await run(['step', '--index', '0', '--name', 'compile', '--', 'exit 0']);
    expect(code).toBe(0);
    const emitted = await events();
    expect(emitted.map((e) => e.status)).toEqual(['RUNNING', 'SUCCEEDED']);
    expect(emitted[0]).toMatchObject({ runId: 'octo/app#ci#7', job: 'build', stepIndex: 0 });
    expect(warnings).toEqual([]);
  });

  it('propagates a failing step exit code and reports FAILED', async () => {
    const code = await run(['step', '--index', '1', '--', 'exit 3']);
    expect(code).toBe(3);
    expect((await events()).map((e) => e.status)).toEqual(['RUNNING', 'FAILED']);
  });

  it('skipIf exit 0 → SKIPPED with reason skip_if; the step never runs', async () => {
    const marker = join(dir, 'ran');
    const code = await run([
      'step',
      '--index',
      '2',
      '--skip-if',
      'true',
      '--',
      `touch ${marker}`,
    ]);
    expect(code).toBe(0);
    const emitted = await events();
    expect(emitted).toHaveLength(1);
    expect(emitted[0]).toMatchObject({ status: 'SKIPPED', reason: 'skip_if', stepIndex: 2 });
    await expect(readFile(marker)).rejects.toThrow();
  });

  it('skipIf nonzero → the step runs normally', async () => {
    const marker = join(dir, 'ran');
    const code = await run([
      'step',
      '--index',
      '2',
      '--skip-if',
      'false',
      '--',
      `touch ${marker}`,
    ]);
    expect(code).toBe(0);
    expect((await events()).map((e) => e.status)).toEqual(['RUNNING', 'SUCCEEDED']);
    await expect(readFile(marker)).resolves.toBeDefined();
  });
});
