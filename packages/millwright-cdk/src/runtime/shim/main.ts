import { spawn } from 'node:child_process';
import { EventBridgeClient } from '@aws-sdk/client-eventbridge';
import { EVENT_BUS_ENV, STEP_EVENTS_FILE_ENV } from '@copperbox/millwright-state';
import { ParsedCli, UNIMPLEMENTED_EXIT_CODE, USAGE_EXIT_CODE, parseCli } from './cli';
import { EventBridgeStepEmitter, FileStepEmitter } from './emitters';
import { CommandRunner, StepEventEmitter, StepIdentity, runStep } from './shim';

/**
 * The shim's host wiring: identity from the dispatch environment, the event
 * sink from the sink env contract, commands through the image's POSIX shell
 * with inherited stdio — the same binary in CodeBuild and bind-mounted in a
 * local `docker run` (spec §11.2). Configuration failures use the usage exit
 * code and never reach the step command: a shim that cannot say WHO it is
 * reporting for must not run anything.
 */

class ShellRunner implements CommandRunner {
  async run(command: string): Promise<number> {
    return new Promise((resolvePromise, rejectPromise) => {
      const child = spawn('/bin/sh', ['-c', command], { stdio: 'inherit' });
      child.on('error', rejectPromise);
      // Killed by a signal (code null): report failure without inventing
      // a shell-specific 128+n encoding.
      child.on('exit', (code) => resolvePromise(code ?? 1));
    });
  }
}

class NullEmitter implements StepEventEmitter {
  async emit(): Promise<void> {}
}

function chooseEmitter(
  env: NodeJS.ProcessEnv,
  warn: (message: string) => void,
): StepEventEmitter {
  const filePath = env[STEP_EVENTS_FILE_ENV];
  if (filePath) {
    return new FileStepEmitter(filePath);
  }
  const busName = env[EVENT_BUS_ENV];
  if (busName) {
    return new EventBridgeStepEmitter(new EventBridgeClient({}), busName);
  }
  warn(
    `millwright-shim: neither ${STEP_EVENTS_FILE_ENV} nor ${EVENT_BUS_ENV} is set; ` +
      'step events will not be reported',
  );
  return new NullEmitter();
}

export interface MainDeps {
  readonly warn: (message: string) => void;
  readonly runner?: CommandRunner;
  readonly emitter?: StepEventEmitter;
}

export async function main(
  argv: readonly string[],
  env: NodeJS.ProcessEnv,
  deps: MainDeps = { warn: (message) => console.error(message) },
): Promise<number> {
  const parsed: ParsedCli = parseCli(argv);
  if (parsed.kind === 'error') {
    deps.warn(`millwright-shim: ${parsed.message}`);
    return USAGE_EXIT_CODE;
  }
  if (parsed.kind === 'unimplemented') {
    deps.warn(
      `millwright-shim: "${parsed.command}" is not delivered by this shim build; ` +
        'update the deployed control plane',
    );
    return UNIMPLEMENTED_EXIT_CODE;
  }

  const runId = env.MILLWRIGHT_RUN_ID;
  const job = env.MILLWRIGHT_JOB;
  if (!runId || !job) {
    deps.warn(
      'millwright-shim: MILLWRIGHT_RUN_ID and MILLWRIGHT_JOB must be set by the dispatcher',
    );
    return USAGE_EXIT_CODE;
  }
  const identity: StepIdentity = { runId, job };

  return runStep(
    {
      runner: deps.runner ?? new ShellRunner(),
      emitter: deps.emitter ?? chooseEmitter(env, deps.warn),
      clock: Date.now,
      warn: deps.warn,
    },
    identity,
    parsed.spec,
  );
}
