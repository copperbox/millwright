/**
 * The run executor's execution input — the contract the launcher's
 * `SfnExecutionStarter` pins (its issue): `action: 'run'` carries a created
 * run's coordinates; `action: 'synth-only'` is the bootstrap execution,
 * idempotently keyed by (repo, ref, sha), stop-after-synth.
 *
 * The synth phase re-validates the shape defensively: these Lambdas are
 * invoked by ARN and a malformed input should fail loudly at the boundary,
 * not deep inside a StartBuild call.
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

export type ExecutionInput = RunExecutionInput | SynthOnlyExecutionInput;

export class ExecutionInputError extends Error {}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0;
}

export function parseExecutionInput(value: unknown): ExecutionInput {
  if (typeof value !== 'object' || value === null) {
    throw new ExecutionInputError(`Execution input must be an object, got ${typeof value}`);
  }
  const input = value as Record<string, unknown>;
  const common =
    isNonEmptyString(input.repo) && isNonEmptyString(input.ref) && isNonEmptyString(input.sha);

  if (input.action === 'synth-only') {
    if (!common) {
      throw new ExecutionInputError(
        'synth-only execution input must carry repo, ref and sha',
      );
    }
    return {
      action: 'synth-only',
      repo: input.repo as string,
      ref: input.ref as string,
      sha: input.sha as string,
    };
  }

  if (input.action === 'run') {
    if (
      !common ||
      !isNonEmptyString(input.runId) ||
      !isNonEmptyString(input.workflow) ||
      !isNonEmptyString(input.trigger) ||
      !Number.isInteger(input.runNumber) ||
      (input.runNumber as number) < 1
    ) {
      throw new ExecutionInputError(
        'run execution input must carry runId, repo, workflow, runNumber, ref, sha and trigger',
      );
    }
    return {
      action: 'run',
      runId: input.runId as string,
      repo: input.repo as string,
      workflow: input.workflow as string,
      runNumber: input.runNumber as number,
      ref: input.ref as string,
      sha: input.sha as string,
      trigger: input.trigger as string,
      ...(input.inputs !== undefined
        ? { inputs: input.inputs as Record<string, string | boolean> }
        : {}),
    };
  }

  throw new ExecutionInputError(
    `Unknown execution input action "${String(input.action)}" (expected "run" or "synth-only")`,
  );
}
