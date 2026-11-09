import { createHash } from 'node:crypto';
import type { SFNClient } from '@aws-sdk/client-sfn';
import { DescribeExecutionCommand, StartExecutionCommand } from '@aws-sdk/client-sfn';
import {
  RunItem,
  executionArn,
  executionName,
  formatRunId,
  synthExecutionName,
} from '@copperbox/millwright-state';

/**
 * Step 7: `StartExecution` on the run executor, always under a deterministic,
 * content-derived execution name — Step Functions treats a repeated
 * StartExecution with the same name as the same execution, which is the
 * final idempotence layer under crash-and-redeliver.
 *
 * The input contract with the run-executor state machine (owned by its own
 * issue): `action: 'run'` carries the created run's coordinates; `action:
 * 'synth-only'` is the bootstrap execution — same machine, stop-after-synth,
 * idempotently keyed by (repo, ref, sha). It validates the model, writes the
 * registry entry and reports the `millwright / synth` check, dispatching no
 * jobs.
 */

export interface ExecutionStarter {
  /** Idempotent under a run-derived deterministic execution name. */
  startRun(run: RunItem): Promise<void>;
  /** Bootstrap synth-only execution, idempotently keyed by (repo, ref, sha). */
  startSynthOnly(repo: string, ref: string, sha: string): Promise<void>;
}

export interface RunExecutionInput {
  readonly action: 'run';
  readonly runId: string;
  readonly repo: string;
  readonly workflow: string;
  readonly runNumber: number;
  readonly ref: string;
  readonly sha: string;
  readonly trigger: string;
  readonly inputs?: Readonly<Record<string, string | boolean>>;
  /**
   * Skip straight to the decider loop. Set on carry-over executions (synth
   * already happened) and on reruns (the launcher prefix-copied the stored
   * model — reruns never re-synth, spec §7.7).
   */
  readonly resume?: true;
}

export interface SynthOnlyExecutionInput {
  readonly action: 'synth-only';
  readonly repo: string;
  readonly ref: string;
  readonly sha: string;
}

/**
 * Naming lives in millwright-state so the CLI can derive the same names
 * (doctor looks a repo's bootstrap synth up by name). Re-exported for the
 * runtime's existing callers.
 */
export { executionName };

/**
 * The name the launcher (and the group hand-off) starts a run's execution
 * under — derivable from the run row alone, which is how the sweep finds a
 * run's execution again without storing its ARN.
 */
export function runExecutionName(run: RunItem): string {
  return executionName('run', `${run.repo}-${run.workflow}-${run.runNumber}`, formatRunId(run));
}

/**
 * Deterministic, chainable carry-over execution name: each generation hashes
 * its predecessor's name, so retries within one execution reuse the same
 * name (idempotent under ExecutionAlreadyExists) while successive
 * generations never collide. Shared with the sweep, which walks the same
 * chain forward to find a long run's current execution.
 */
export function carryOverExecutionName(currentExecutionName: string): string {
  return `co-${createHash('sha256').update(currentExecutionName).digest('hex').slice(0, 40)}`;
}

/**
 * Whether an execution of the run executor is still open. 'missing' is its
 * own answer: before the launcher's StartExecution lands the execution does
 * not exist yet, and after a carry-over the successor may not exist because
 * the chain ended there — callers decide which it is from the hop.
 */
export type ExecutionLiveness = 'running' | 'closed' | 'missing';

export interface ExecutionInspector {
  describe(name: string): Promise<ExecutionLiveness>;
}

export class SfnExecutionStarter implements ExecutionStarter {
  constructor(
    private readonly client: SFNClient,
    private readonly stateMachineArn: string,
    private readonly log: (message: string, fields?: Record<string, unknown>) => void,
  ) {}

  async startRun(run: RunItem): Promise<void> {
    const runId = formatRunId(run);
    const input: RunExecutionInput = {
      action: 'run',
      runId,
      repo: run.repo,
      workflow: run.workflow,
      runNumber: run.runNumber,
      ref: run.ref,
      sha: run.sha,
      trigger: run.trigger,
      ...(run.inputs ? { inputs: run.inputs } : {}),
      ...(run.rerunOf ? { resume: true as const } : {}),
    };
    await this.start(runExecutionName(run), input);
  }

  async startSynthOnly(repo: string, ref: string, sha: string): Promise<void> {
    const input: SynthOnlyExecutionInput = { action: 'synth-only', repo, ref, sha };
    await this.start(synthExecutionName(repo, ref, sha), input);
  }

  private async start(name: string, input: RunExecutionInput | SynthOnlyExecutionInput) {
    try {
      await this.client.send(
        new StartExecutionCommand({
          stateMachineArn: this.stateMachineArn,
          name,
          input: JSON.stringify(input),
        }),
      );
    } catch (err) {
      // Same deterministic name ⇒ this work was already started. (SFN only
      // raises this when the input differs; identical calls succeed quietly.)
      if ((err as { name?: string })?.name === 'ExecutionAlreadyExists') {
        this.log('execution already started', { name });
        return;
      }
      throw err;
    }
  }
}

/** `DescribeExecution` on the run executor, by execution name. */
export class SfnExecutionInspector implements ExecutionInspector {
  constructor(
    private readonly client: SFNClient,
    private readonly stateMachineArn: string,
  ) {}

  async describe(name: string): Promise<ExecutionLiveness> {
    const arn = executionArn(this.stateMachineArn, name);
    if (!arn) {
      throw new Error(`Not a state machine ARN: ${this.stateMachineArn}`);
    }
    try {
      const result = await this.client.send(new DescribeExecutionCommand({ executionArn: arn }));
      return result.status === 'RUNNING' ? 'running' : 'closed';
    } catch (err) {
      if ((err as { name?: string })?.name === 'ExecutionDoesNotExist') {
        return 'missing';
      }
      throw err;
    }
  }
}
