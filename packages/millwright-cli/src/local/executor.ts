import { spawn } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { BuildOutcome } from '@copperbox/millwright-state';
import { CommandError } from '../config-plane';

/**
 * `Executor` — how a dispatched job actually runs (spec §14): `StartBuild`
 * in the cloud, `docker run` here. The host loop only ever sees this seam
 * plus each execution's terminal {@link BuildOutcome}, so the decider drives
 * both hosts identically.
 */

/** Everything one `docker run` needs, assembled by the host. */
export interface LocalJobSpec {
  readonly job: string;
  readonly image: string;
  /** Container name — the local analog of a build id (docker stop target). */
  readonly container: string;
  /** Host directory mounted as the job's working directory. */
  readonly workDir: string;
  readonly outDir: string;
  readonly cacheDir: string;
  readonly shimDir: string;
  /** Host path of the step-events JSON-lines file (its directory is mounted). */
  readonly eventsFile: string;
  /** Host path of the rendered phase script. */
  readonly scriptFile: string;
  /** Plain env vars: identity, data-plane paths, declared env, secrets. */
  readonly env: Readonly<Record<string, string>>;
  /** `--platform` passthrough when the operator asked for an exact arch. */
  readonly platform?: string;
  /** Privileged jobs mount the host docker socket (spec §14). */
  readonly privileged: boolean;
  readonly timeoutMinutes?: number;
}

export interface LocalExecution {
  readonly job: string;
  readonly container: string;
  /** Resolves with the execution's terminal outcome; never rejects. */
  readonly outcome: Promise<BuildOutcome>;
  /** Cancellation path: stop the container (idempotent). */
  stop(): Promise<void>;
}

export interface Executor {
  /** The local `StartBuild`: launch one job's container. */
  start(spec: LocalJobSpec): LocalExecution;
  /** Fail fast (before any state is written) when docker is unusable. */
  preflight(): Promise<void>;
}

/** Container-side mount points; fixed so the generated env is predictable. */
export const CONTAINER_WORKSPACE = '/millwright/workspace';
export const CONTAINER_OUT = '/millwright/out';
export const CONTAINER_CACHE = '/millwright/cache';
export const CONTAINER_SHIM = '/millwright/shim';
export const CONTAINER_EVENTS = '/millwright/events';
export const CONTAINER_SCRIPT = '/millwright/job.sh';

const DOCKER_SOCKET = '/var/run/docker.sock';

export interface DockerProcess {
  /** Resolves with the exit code; -1 when the CLI could not be spawned. */
  readonly exited: Promise<number>;
}

export interface DockerExecutorDeps {
  /** Spawn one process, line-buffered output to `onLine`; tests fake this. */
  readonly run: (
    command: string,
    args: readonly string[],
    onLine: (line: string) => void,
  ) => DockerProcess;
  readonly onLog: (job: string, line: string) => void;
  readonly warn: (message: string) => void;
}

/** Spawn wiring for the real docker CLI, line-buffering both stdio streams. */
export function createDockerProcessRunner(): DockerExecutorDeps['run'] {
  return (command, args, onLine) => {
    const child = spawn(command, args as string[], { stdio: ['ignore', 'pipe', 'pipe'] });
    let buffered = { out: '', err: '' };
    const push = (key: 'out' | 'err', chunk: Buffer) => {
      buffered[key] += chunk.toString('utf8');
      const lines = buffered[key].split('\n');
      buffered[key] = lines.pop() ?? '';
      for (const line of lines) {
        onLine(line);
      }
    };
    child.stdout.on('data', (chunk) => push('out', chunk));
    child.stderr.on('data', (chunk) => push('err', chunk));
    const exited = new Promise<number>((resolve) => {
      child.on('error', () => resolve(-1));
      child.on('close', (code) => {
        for (const rest of [buffered.out, buffered.err]) {
          if (rest) {
            onLine(rest);
          }
        }
        resolve(code ?? 1);
      });
    });
    return { exited };
  };
}

export function buildDockerRunArgs(spec: LocalJobSpec): string[] {
  const args = [
    'run',
    '--rm',
    '--name',
    spec.container,
    '--workdir',
    CONTAINER_WORKSPACE,
    '-v',
    `${spec.workDir}:${CONTAINER_WORKSPACE}`,
    '-v',
    `${spec.outDir}:${CONTAINER_OUT}`,
    '-v',
    `${spec.cacheDir}:${CONTAINER_CACHE}`,
    '-v',
    `${spec.shimDir}:${CONTAINER_SHIM}:ro`,
    '-v',
    `${path.dirname(spec.eventsFile)}:${CONTAINER_EVENTS}`,
    '-v',
    `${spec.scriptFile}:${CONTAINER_SCRIPT}:ro`,
  ];
  for (const [name, value] of Object.entries(spec.env)) {
    args.push('-e', `${name}=${value}`);
  }
  if (spec.platform) {
    args.push('--platform', spec.platform);
  }
  if (spec.privileged) {
    args.push('-v', `${DOCKER_SOCKET}:${DOCKER_SOCKET}`);
  }
  args.push(spec.image, '/bin/sh', CONTAINER_SCRIPT);
  return args;
}

/**
 * The `docker run` executor. Outcome mapping mirrors the cloud's build
 * judgement: exit 0 → SUCCEEDED, non-zero → FAILED (command failures never
 * auto-retry), our own stop → STOPPED or TIMED_OUT by reason, and a docker
 * CLI that cannot run at all → FAULT (retryable within the attempt cap,
 * like any infrastructure failure).
 */
export class DockerExecutor implements Executor {
  constructor(private readonly deps: DockerExecutorDeps) {}

  async preflight(): Promise<void> {
    const probe = this.deps.run('docker', ['info', '--format', '{{.ServerVersion}}'], () => {});
    if ((await probe.exited) !== 0) {
      throw new CommandError(
        'docker is required for local runs and its daemon did not answer — is docker running?',
      );
    }
  }

  start(spec: LocalJobSpec): LocalExecution {
    fs.mkdirSync(path.dirname(spec.eventsFile), { recursive: true });
    // Pre-create the events file so the container user can append to the
    // bind-mounted path regardless of its uid.
    fs.writeFileSync(spec.eventsFile, '', { flag: 'a' });
    fs.chmodSync(spec.eventsFile, 0o666);

    let stopReason: 'stopped' | 'timed_out' | undefined;
    const process = this.deps.run('docker', buildDockerRunArgs(spec), (line) =>
      this.deps.onLog(spec.job, line),
    );

    const stopContainer = async (reason: 'stopped' | 'timed_out'): Promise<void> => {
      if (stopReason) {
        return;
      }
      stopReason = reason;
      const stop = this.deps.run('docker', ['stop', spec.container], () => {});
      if ((await stop.exited) !== 0) {
        this.deps.warn(`millwright: docker stop ${spec.container} did not succeed`);
      }
    };

    let timer: NodeJS.Timeout | undefined;
    if (spec.timeoutMinutes !== undefined) {
      timer = setTimeout(
        () => void stopContainer('timed_out'),
        spec.timeoutMinutes * 60 * 1000,
      );
      timer.unref?.();
    }

    const outcome = process.exited.then((code): BuildOutcome => {
      if (timer) {
        clearTimeout(timer);
      }
      if (stopReason === 'timed_out') {
        return 'TIMED_OUT';
      }
      if (stopReason === 'stopped') {
        return 'STOPPED';
      }
      if (code === 0) {
        return 'SUCCEEDED';
      }
      // -1: the docker CLI itself could not be spawned; 125: the daemon
      // refused the run (both infrastructure, not the job's commands).
      if (code === -1 || code === 125) {
        return 'FAULT';
      }
      return 'FAILED';
    });

    return {
      job: spec.job,
      container: spec.container,
      outcome,
      stop: () => stopContainer('stopped'),
    };
  }
}
