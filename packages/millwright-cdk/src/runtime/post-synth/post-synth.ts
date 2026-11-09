import {
  BOOTSTRAP_SYNTH_CONTEXT,
  DesiredCheckState,
  RegistryItem,
  RegistryWorkflowEntry,
  desiredBootstrapSynthFailed,
  desiredBootstrapSynthSucceeded,
  desiredSynthFailed,
  desiredSynthSucceeded,
  registryKey,
  synthCheckContext as workflowSynthCheckContext,
} from '@copperbox/millwright-state';
import { RunModel, validateRunModel } from '@copperbox/millwright-workflows';
import { DesiredCheckWrite, UnownedDesiredCheckWrite } from '../shared/checks';
import {
  ExecutionInput,
  RunExecutionInput,
  parseExecutionInput,
} from '../shared/execution-input';
import { synthDestinationPrefix } from '../shared/synth-locations';

/**
 * Post-synth core (spec §7.2, §8.3) — the control-plane side of the synth
 * trust boundary. The synth job executes repo-controlled code and cannot
 * touch the table (IAM); THIS step reads `model.json` back from S3,
 * schema-validates it, and only then writes the `REG#<repo>` / `REF#<ref>`
 * registry entry the launcher matches events against. Closing the
 * registry-overwrite vector at the root means every write here is keyed by
 * the EXECUTION's identity (repo/ref/sha from the launcher), never by
 * anything the model claims — a lying model is rejected, not re-keyed.
 *
 * It also completes the synth check (spec §13.2 lifecycle): the launcher
 * created `<workflow> / synth` as `in_progress` at run start; this step
 * writes its conclusion as a desired state the reporter posts to GitHub.
 *
 * Job-role policy reconciliation for `secretsAllowedRefs`-matched refs
 * (§10.2) also belongs to this step; it lands with the IAM issue and plugs
 * in after validation, before the registry write.
 */

export const MODEL_OBJECT_NAME = 'model.json';

/** Bootstrap executions report the repo-level context (spec §B2). */
export const BOOTSTRAP_SYNTH_CHECK_CONTEXT = BOOTSTRAP_SYNTH_CONTEXT;

export class PostSynthError extends Error {}

export interface PostSynthEvent {
  /** The state machine's `$` — the launcher-authored execution input. */
  readonly input: unknown;
}

export interface PostSynthStore {
  /** Plain put — the registry is refreshed by every successful synth. */
  putRegistry(item: RegistryItem): Promise<void>;
  /** A run's synth check: the §13.2 ownership upsert; false when a newer run owns the context. */
  putDesiredCheck(write: DesiredCheckWrite, nowMs: number): Promise<boolean>;
  /** The bootstrap `millwright / synth` check: unowned upsert, single writer per sha. */
  putBootstrapCheck(write: UnownedDesiredCheckWrite, nowMs: number): Promise<void>;
}

export interface PostSynthDeps {
  readonly config: {
    /** The control plane's supported run-model schemaVersion. */
    readonly schemaCeiling: number;
    readonly metadataRetentionDays: number;
  };
  /** Read from the artifact bucket; undefined when the key is absent. */
  readonly readObject: (key: string) => Promise<string | undefined>;
  readonly store: PostSynthStore;
  readonly now: () => number;
  readonly log: (message: string, fields?: Record<string, unknown>) => void;
}

export interface PostSynthResult {
  readonly schemaVersion: number;
  readonly workflows: readonly string[];
  readonly registryRef: string;
}

/** `<workflow> / synth` for runs; the repo-level context for bootstraps. */
export function synthCheckContext(input: ExecutionInput): string {
  return input.action === 'synth-only'
    ? BOOTSTRAP_SYNTH_CHECK_CONTEXT
    : workflowSynthCheckContext(input.workflow);
}

/** The run id as the CLI displays it — the check owner and summary label. */
export function runCheckLabel(input: RunExecutionInput): string {
  return `${input.workflow}#${input.runNumber}`;
}

export async function completePostSynth(
  deps: PostSynthDeps,
  event: PostSynthEvent,
): Promise<PostSynthResult> {
  const input = parseExecutionInput(event.input);
  try {
    const model = await readValidatedModel(deps, input);
    await writeRegistryEntry(deps, input, model);
    await writeSynthCheck(deps, input, synthSucceeded(input, model));
    return {
      schemaVersion: model.schemaVersion,
      workflows: model.workflows.map((wf) => wf.name),
      registryRef: input.ref,
    };
  } catch (err) {
    const message = (err as Error).message ?? String(err);
    // Surface the real reason in the synth check before failing the step —
    // an invalid model must be a visible failure, not a silent one. A failed
    // check write must not mask the original error.
    try {
      await writeSynthCheck(deps, input, synthFailed(input, message));
    } catch (checkErr) {
      deps.log('could not record the synth check failure', { error: String(checkErr) });
    }
    throw err instanceof PostSynthError ? err : new PostSynthError(message);
  }
}

async function readValidatedModel(
  deps: PostSynthDeps,
  input: ExecutionInput,
): Promise<RunModel> {
  const key = `${synthDestinationPrefix(input)}${MODEL_OBJECT_NAME}`;
  const body = await deps.readObject(key);
  if (body === undefined) {
    throw new PostSynthError(
      `The synth job left no ${MODEL_OBJECT_NAME} at ${key} — the build reported success ` +
        'without producing a model',
    );
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    throw new PostSynthError(`${MODEL_OBJECT_NAME} at ${key} is not valid JSON`);
  }

  const validation = validateRunModel(parsed, {
    controlPlaneSchemaVersion: deps.config.schemaCeiling,
  });
  if (!validation.ok) {
    const issues = validation.issues.map((i) => `${i.path}: ${i.message}`).join('; ');
    throw new PostSynthError(`Invalid run model: ${issues}`);
  }

  // The model is authored next to repo-controlled code: its claimed identity
  // must match the execution's, or a definition could synthesize under one
  // repo and register (or run) as another.
  const model = parsed as RunModel;
  if (model.repo !== input.repo) {
    throw new PostSynthError(
      `Run model claims repo "${model.repo}" but this execution is for "${input.repo}"`,
    );
  }
  if (model.commit !== input.sha) {
    throw new PostSynthError(
      `Run model claims commit "${model.commit}" but this execution triggered at "${input.sha}"`,
    );
  }
  return model;
}

/**
 * Extract exactly the `(triggers, concurrency)` map (spec §8.3) — the
 * launcher matches events against this entry, so nothing else from the
 * model crosses into the registry.
 */
async function writeRegistryEntry(
  deps: PostSynthDeps,
  input: ExecutionInput,
  model: RunModel,
): Promise<void> {
  const workflows: Record<string, RegistryWorkflowEntry> = {};
  for (const workflow of model.workflows) {
    workflows[workflow.name] = {
      triggers: workflow.triggers,
      ...(workflow.concurrency
        ? {
            concurrency: {
              group: workflow.concurrency.group,
              policy: workflow.concurrency.policy,
            },
          }
        : {}),
    };
  }
  const item: RegistryItem = {
    ...registryKey(input.repo, input.ref),
    repo: input.repo,
    ref: input.ref,
    schemaVersion: model.schemaVersion,
    workflows,
  };
  await deps.store.putRegistry(item);
  deps.log('registry entry written', { repo: input.repo, ref: input.ref });
}

/**
 * Success content: a run's check counts the job checks the decider is about
 * to create for ITS workflow; a bootstrap's counts the workflows registered.
 * A run whose workflow vanished from the model still gets a success here —
 * the decider reports that as the run's failure, not synth's.
 */
function synthSucceeded(input: ExecutionInput, model: RunModel): DesiredCheckState {
  if (input.action === 'synth-only') {
    return desiredBootstrapSynthSucceeded(input.sha, model.workflows.length);
  }
  const jobs = model.workflows.find((wf) => wf.name === input.workflow)?.jobs.length ?? 0;
  return desiredSynthSucceeded(runCheckLabel(input), jobs);
}

function synthFailed(input: ExecutionInput, message: string): DesiredCheckState {
  return input.action === 'synth-only'
    ? desiredBootstrapSynthFailed(input.sha, message)
    : desiredSynthFailed(runCheckLabel(input), message);
}

/**
 * Synth check desired state. Runs get the workflow-scoped `<wf> / synth`
 * context owned by their run id — the same (repo, sha, context, owner) the
 * launcher wrote `in_progress` under, so this completes that check run
 * instead of minting another; a newer run owning the context drops the write
 * silently. Bootstraps report `millwright / synth`, which has a single
 * writer per sha (the idempotent bootstrap execution) and needs no ordering
 * rule (spec §B2). Rerun never re-synths, so one (repo, sha, context)
 * normally sees exactly one completing writer.
 */
async function writeSynthCheck(
  deps: PostSynthDeps,
  input: ExecutionInput,
  desired: DesiredCheckState,
): Promise<void> {
  const context = synthCheckContext(input);
  if (input.action === 'synth-only') {
    await deps.store.putBootstrapCheck(
      { repo: input.repo, sha: input.sha, context, desired },
      deps.now(),
    );
    return;
  }
  const written = await deps.store.putDesiredCheck(
    {
      repo: input.repo,
      sha: input.sha,
      context,
      ownerRun: runCheckLabel(input),
      ownerRunNumber: input.runNumber,
      desired,
    },
    deps.now(),
  );
  if (!written) {
    deps.log('synth check owned by a newer run; not updated', {
      runId: input.runId,
      context,
    });
  }
}
