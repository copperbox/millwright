import {
  CheckStateItem,
  RegistryItem,
  RegistryWorkflowEntry,
  checkStateKey,
  registryKey,
  withMetadataTtl,
} from '@copperbox/millwright-state';
import { RunModel, validateRunModel } from '@copperbox/millwright-workflows';
import {
  ExecutionInput,
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
 * Job-role policy reconciliation for `secretsAllowedRefs`-matched refs
 * (§10.2) also belongs to this step; it lands with the IAM issue and plugs
 * in after validation, before the registry write.
 */

export const MODEL_OBJECT_NAME = 'model.json';

/** Bootstrap executions report the repo-level context (spec §B2). */
export const BOOTSTRAP_SYNTH_CHECK_CONTEXT = 'millwright / synth';

export class PostSynthError extends Error {}

export interface PostSynthEvent {
  /** The state machine's `$` — the launcher-authored execution input. */
  readonly input: unknown;
}

/**
 * What the synth check should show, serialized into the check row's
 * `desired` attribute. The reporter (its own issue) renders it to GitHub.
 */
export interface SynthCheckDesired {
  readonly conclusion: 'success' | 'failure';
  readonly summary: string;
}

export interface PostSynthStore {
  /** Plain put — the registry is refreshed by every successful synth. */
  putRegistry(item: RegistryItem): Promise<void>;
  putCheckState(item: CheckStateItem): Promise<void>;
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
    : `${input.workflow} / synth`;
}

export async function completePostSynth(
  deps: PostSynthDeps,
  event: PostSynthEvent,
): Promise<PostSynthResult> {
  const input = parseExecutionInput(event.input);
  try {
    const model = await readValidatedModel(deps, input);
    await writeRegistryEntry(deps, input, model);
    await writeCheckState(deps, input, {
      conclusion: 'success',
      summary: `synthesized ${model.workflows.length} workflow(s) at ${input.sha.slice(0, 12)}`,
    });
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
      await writeCheckState(deps, input, { conclusion: 'failure', summary: message });
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
 * Synth check desired state. Runs get the workflow-scoped `<wf> / synth`
 * context owned by their run id; bootstraps report `millwright / synth`,
 * which has a single writer per sha (the idempotent bootstrap execution)
 * and needs no ordering rule (spec §B2). Rerun never re-synths, so one
 * (repo, sha, context) normally sees exactly one writer.
 */
async function writeCheckState(
  deps: PostSynthDeps,
  input: ExecutionInput,
  desired: SynthCheckDesired,
): Promise<void> {
  const context = synthCheckContext(input);
  const item: CheckStateItem = withMetadataTtl(
    {
      ...checkStateKey(input.repo, input.sha, context),
      repo: input.repo,
      sha: input.sha,
      context,
      desired: JSON.stringify(desired),
      ...(input.action === 'run' ? { ownerRun: input.runId } : {}),
    },
    deps.now(),
    deps.config.metadataRetentionDays,
  );
  await deps.store.putCheckState(item);
}
