import { createHash } from 'node:crypto';
import type { SFNClient } from '@aws-sdk/client-sfn';
import { StartExecutionCommand } from '@aws-sdk/client-sfn';
import { RunItem, formatRunId } from '@copperbox/millwright-state';
import { ExecutionStarter } from './launcher';

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
}

export interface SynthOnlyExecutionInput {
  readonly action: 'synth-only';
  readonly repo: string;
  readonly ref: string;
  readonly sha: string;
}

const NAME_LIMIT = 80;

/** `<prefix>-<readable>-<hash12(uniq)>`, confined to SFN's name charset. */
export function executionName(prefix: string, readable: string, uniq: string): string {
  const hash = createHash('sha256').update(uniq).digest('hex').slice(0, 12);
  const safe = readable.replace(/[^A-Za-z0-9_-]+/g, '-').replace(/^-+|-+$/g, '');
  const budget = NAME_LIMIT - prefix.length - hash.length - 2;
  return `${prefix}-${safe.slice(0, budget)}-${hash}`;
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
    };
    await this.start(
      executionName('run', `${run.repo}-${run.workflow}-${run.runNumber}`, runId),
      input,
    );
  }

  async startSynthOnly(repo: string, ref: string, sha: string): Promise<void> {
    const input: SynthOnlyExecutionInput = { action: 'synth-only', repo, ref, sha };
    await this.start(
      executionName('synth', `${repo}-${sha.slice(0, 12)}`, `${repo}#${ref}#${sha}`),
      input,
    );
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
