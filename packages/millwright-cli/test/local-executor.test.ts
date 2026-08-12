import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { CommandError } from '../src/config-plane';
import {
  DockerExecutor,
  DockerExecutorDeps,
  LocalJobSpec,
  buildDockerRunArgs,
} from '../src/local/executor';

const tmpdirs: string[] = [];

function tmp(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'millwright-executor-'));
  tmpdirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of tmpdirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

function spec(overrides: Partial<LocalJobSpec> = {}): LocalJobSpec {
  const dir = tmp();
  return {
    job: 'build',
    image: 'public.ecr.aws/docker/library/node:22',
    container: 'millwright-local-1-build-1',
    workDir: path.join(dir, 'work'),
    outDir: path.join(dir, 'out'),
    cacheDir: path.join(dir, 'cache'),
    shimDir: path.join(dir, 'shim'),
    eventsFile: path.join(dir, 'events', 'build.jsonl'),
    scriptFile: path.join(dir, 'scripts', 'build.sh'),
    env: { MILLWRIGHT_JOB: 'build' },
    privileged: false,
    ...overrides,
  };
}

interface Invocation {
  readonly command: string;
  readonly args: readonly string[];
  readonly onLine: (line: string) => void;
  resolve: (code: number) => void;
}

function harness(): {
  deps: DockerExecutorDeps;
  invocations: Invocation[];
  logs: string[];
  warnings: string[];
} {
  const invocations: Invocation[] = [];
  const logs: string[] = [];
  const warnings: string[] = [];
  const deps: DockerExecutorDeps = {
    run: (command, args, onLine) => {
      const invocation: Invocation = { command, args, onLine, resolve: () => {} };
      const exited = new Promise<number>((resolve) => {
        invocation.resolve = resolve;
      });
      invocations.push(invocation);
      return { exited };
    },
    onLog: (job, line) => logs.push(`[${job}] ${line}`),
    warn: (message) => warnings.push(message),
  };
  return { deps, invocations, logs, warnings };
}

describe('buildDockerRunArgs', () => {
  it('mounts the data plane, shim, events and script, and names the container', () => {
    const jobSpec = spec({ platform: 'linux/arm64' });
    const args = buildDockerRunArgs(jobSpec);
    expect(args.slice(0, 2)).toEqual(['run', '--rm']);
    expect(args).toContain('millwright-local-1-build-1');
    expect(args.join(' ')).toContain(`${jobSpec.workDir}:/millwright/workspace`);
    expect(args.join(' ')).toContain(`${jobSpec.outDir}:/millwright/out`);
    expect(args.join(' ')).toContain(`${jobSpec.cacheDir}:/millwright/cache`);
    expect(args.join(' ')).toContain(`${jobSpec.shimDir}:/millwright/shim:ro`);
    expect(args.join(' ')).toContain(`${path.dirname(jobSpec.eventsFile)}:/millwright/events`);
    expect(args.join(' ')).toContain(`${jobSpec.scriptFile}:/millwright/job.sh:ro`);
    expect(args.join(' ')).toContain('-e MILLWRIGHT_JOB=build');
    expect(args.join(' ')).toContain('--platform linux/arm64');
    // The image and the entry command come last.
    expect(args.slice(-3)).toEqual([jobSpec.image, '/bin/sh', '/millwright/job.sh']);
    expect(args.join(' ')).not.toContain('/var/run/docker.sock');
  });

  it('mounts the host docker socket for privileged jobs', () => {
    const args = buildDockerRunArgs(spec({ privileged: true }));
    expect(args.join(' ')).toContain('/var/run/docker.sock:/var/run/docker.sock');
  });
});

describe('DockerExecutor', () => {
  it('maps exit codes to build outcomes: 0 → SUCCEEDED, non-zero → FAILED', async () => {
    const { deps, invocations } = harness();
    const executor = new DockerExecutor(deps);
    const ok = executor.start(spec());
    invocations[0].resolve(0);
    expect(await ok.outcome).toBe('SUCCEEDED');

    const bad = executor.start(spec({ container: 'c2' }));
    invocations[1].resolve(3);
    expect(await bad.outcome).toBe('FAILED');
  });

  it('maps docker-level failures (spawn error, exit 125) to a retryable FAULT', async () => {
    const { deps, invocations } = harness();
    const executor = new DockerExecutor(deps);
    const spawnFail = executor.start(spec());
    invocations[0].resolve(-1);
    expect(await spawnFail.outcome).toBe('FAULT');

    const daemonFail = executor.start(spec({ container: 'c2' }));
    invocations[1].resolve(125);
    expect(await daemonFail.outcome).toBe('FAULT');
  });

  it('stop() issues docker stop and the outcome reads STOPPED', async () => {
    const { deps, invocations } = harness();
    const executor = new DockerExecutor(deps);
    const execution = executor.start(spec());
    const stopped = execution.stop();
    expect(invocations[1].command).toBe('docker');
    expect(invocations[1].args.slice(0, 2)).toEqual(['stop', 'millwright-local-1-build-1']);
    invocations[1].resolve(0);
    await stopped;
    invocations[0].resolve(137);
    expect(await execution.outcome).toBe('STOPPED');
  });

  it('enforces the job timeout: the container is stopped and reads TIMED_OUT', async () => {
    const { deps, invocations } = harness();
    const executor = new DockerExecutor(deps);
    // Sub-minute timeouts are not expressible in the model; drive the timer
    // directly through a tiny fraction of a minute.
    const execution = executor.start(spec({ timeoutMinutes: 0.0001 }));
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(invocations).toHaveLength(2);
    expect(invocations[1].args[0]).toBe('stop');
    invocations[1].resolve(0);
    invocations[0].resolve(137);
    expect(await execution.outcome).toBe('TIMED_OUT');
  });

  it('streams job log lines through onLog', async () => {
    const { deps, invocations, logs } = harness();
    const executor = new DockerExecutor(deps);
    executor.start(spec());
    invocations[0].onLine('npm ci');
    invocations[0].onLine('done');
    expect(logs).toEqual(['[build] npm ci', '[build] done']);
  });

  it('preflight fails plainly when the docker daemon does not answer', async () => {
    const { deps, invocations } = harness();
    const executor = new DockerExecutor(deps);
    const probe = executor.preflight();
    invocations[0].resolve(1);
    await expect(probe).rejects.toThrow(CommandError);
  });
});
