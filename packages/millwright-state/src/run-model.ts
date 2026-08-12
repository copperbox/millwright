/**
 * The run model — synth's output and the contract between definition,
 * cloud orchestration, and the local runner (spec §5). Cloud synth lands it
 * at `runs/…/<n>/in/model.json`; the decider (cloud Lambda host and local
 * runner alike) consumes exactly the fields typed here and ignores the rest,
 * so the shape can grow without touching the decision logic.
 *
 * `model.json` is a named privilege boundary: it is authored inside the
 * synth job, which executes repo-controlled code. Everything read from it is
 * attacker-influenceable and is therefore narrowed defensively here, and the
 * caps below (attempt cap, run deadline) are clamped, never trusted.
 */

/** Per-job total-StartBuild-attempt cap when the model does not override it. */
export const DEFAULT_JOB_ATTEMPTS = 3;

/** Run-level wall-clock deadline default (spec §7.3): 24 hours. */
export const DEFAULT_RUN_DEADLINE_MINUTES = 24 * 60;

/** Deadline ceiling — CodeBuild's own 36 h maximum build duration (C11). */
export const MAX_RUN_DEADLINE_MINUTES = 36 * 60;

export interface RunModelStep {
  readonly run: string;
  readonly name?: string;
  /** Shell command; exit 0 marks the step SKIPPED (`reason: skip_if`). */
  readonly skipIf?: string;
}

export interface RunModelCompute {
  readonly arch?: 'arm64' | 'x86_64';
  readonly size?: 'small' | 'medium' | 'large';
}

/**
 * Keyed dependency cache (spec §12): GHA-style semantics. `key` arrives fully
 * resolved — `hashFiles(...)` is evaluated at synth, where the repo content
 * is — and `restoreKeys` are prefix fallbacks tried in order on an
 * exact-key miss. An exact hit skips the save phase.
 */
export interface RunModelCache {
  readonly key: string;
  readonly paths: readonly string[];
  readonly restoreKeys?: readonly string[];
}

/** One declared artifact: uploaded to `out/<job>/<name>/` after the steps. */
export interface RunModelArtifact {
  readonly name: string;
  readonly paths: readonly string[];
}

/**
 * One declared secret, keyed by the env var it lands in (spec §11.2).
 * `Secret.named(x)` emits a parameter reference (`scope` defaults to the
 * repo); `Secret.fromSecretsManager(arn)` emits a passthrough ARN. Which
 * refs actually receive grants is decided elsewhere (§12a) — nothing here
 * is trusted beyond naming what the job would like.
 */
export type RunModelSecret =
  | { readonly parameter: string; readonly scope?: string }
  | { readonly secretsManager: string };

export interface RunModelJob {
  readonly name: string;
  /** Plain docker-run image string; required for user jobs (§11.1). */
  readonly image?: string;
  readonly compute?: RunModelCompute;
  readonly privileged?: boolean;
  readonly timeoutMinutes?: number;
  /**
   * Total-attempt cap override (spec §7.3, default {@link DEFAULT_JOB_ATTEMPTS}).
   * Counts every StartBuild for the job, not just retries.
   */
  readonly attempts?: number;
  readonly steps: readonly RunModelStep[];
  /** Explicit ordering edges (job names). */
  readonly dependsOn?: readonly string[];
  /** Artifact edges; the producing job is a dependency like any other. */
  readonly consumes?: readonly { readonly job: string; readonly artifact: string }[];
  readonly env?: Readonly<Record<string, string>>;
  readonly produces?: readonly RunModelArtifact[];
  readonly cache?: RunModelCache;
  readonly secrets?: Readonly<Record<string, RunModelSecret>>;
}

export interface RunModelWorkflow {
  readonly name: string;
  /** Run-level wall-clock deadline override, clamped to the CodeBuild ceiling. */
  readonly deadlineMinutes?: number;
  readonly jobs: readonly RunModelJob[];
}

export interface RunModel {
  readonly schemaVersion: number;
  readonly repo: string;
  readonly sha?: string;
  readonly workflows: readonly RunModelWorkflow[];
}

export class RunModelError extends Error {}

/** The workflow a run executes, or an error naming what is wrong. */
export function workflowFromModel(model: RunModel, workflow: string): RunModelWorkflow {
  const found = model.workflows.find((wf) => wf.name === workflow);
  if (!found) {
    throw new RunModelError(
      `Model has no workflow "${workflow}" (has: ${model.workflows.map((w) => w.name).join(', ')})`,
    );
  }
  return found;
}

/** A job's effective total-attempt cap: model override clamped to ≥ 1. */
export function jobAttemptCap(job: RunModelJob): number {
  const cap = job.attempts ?? DEFAULT_JOB_ATTEMPTS;
  return Number.isInteger(cap) && cap >= 1 ? cap : DEFAULT_JOB_ATTEMPTS;
}

/** A workflow's effective deadline in minutes: default 24 h, ceiling 36 h. */
export function runDeadlineMinutes(workflow: RunModelWorkflow): number {
  const deadline = workflow.deadlineMinutes ?? DEFAULT_RUN_DEADLINE_MINUTES;
  if (!Number.isFinite(deadline) || deadline <= 0) {
    return DEFAULT_RUN_DEADLINE_MINUTES;
  }
  return Math.min(deadline, MAX_RUN_DEADLINE_MINUTES);
}

/** All dependency edges of a job: explicit `dependsOn` plus artifact producers. */
export function jobDependencies(job: RunModelJob): readonly string[] {
  const deps = new Set<string>(job.dependsOn ?? []);
  for (const consumed of job.consumes ?? []) {
    deps.add(consumed.job);
  }
  deps.delete(job.name);
  return [...deps];
}

function narrowSteps(value: unknown): RunModelStep[] | undefined {
  if (!Array.isArray(value)) {
    return undefined;
  }
  const steps: RunModelStep[] = [];
  for (const entry of value) {
    if (typeof entry === 'string') {
      steps.push({ run: entry });
      continue;
    }
    if (typeof entry !== 'object' || entry === null) {
      return undefined;
    }
    const run = (entry as { run?: unknown }).run;
    if (typeof run !== 'string' || !run) {
      return undefined;
    }
    const name = (entry as { name?: unknown }).name;
    const skipIf = (entry as { skipIf?: unknown }).skipIf;
    steps.push({
      run,
      name: typeof name === 'string' ? name : undefined,
      skipIf: typeof skipIf === 'string' ? skipIf : undefined,
    });
  }
  return steps;
}

function narrowStringArray(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) {
    return undefined;
  }
  const strings = value.filter((entry): entry is string => typeof entry === 'string' && !!entry);
  return strings.length > 0 ? strings : undefined;
}

/** Malformed cache shapes narrow to "no cache" — fail closed, never guess. */
function narrowCache(value: unknown): RunModelCache | undefined {
  if (typeof value !== 'object' || value === null) {
    return undefined;
  }
  const c = value as Record<string, unknown>;
  const paths = narrowStringArray(c.paths);
  if (typeof c.key !== 'string' || !c.key || !paths) {
    return undefined;
  }
  const restoreKeys = narrowStringArray(c.restoreKeys);
  return { key: c.key, paths, ...(restoreKeys ? { restoreKeys } : {}) };
}

function narrowArtifacts(value: unknown): RunModelArtifact[] | undefined {
  if (!Array.isArray(value)) {
    return undefined;
  }
  const artifacts = value.flatMap((entry): RunModelArtifact[] => {
    if (typeof entry !== 'object' || entry === null) {
      return [];
    }
    const name = (entry as { name?: unknown }).name;
    const paths = narrowStringArray((entry as { paths?: unknown }).paths);
    return typeof name === 'string' && name && paths ? [{ name, paths }] : [];
  });
  return artifacts.length > 0 ? artifacts : undefined;
}

/**
 * Malformed secret references are dropped, not repaired: a missing env var
 * fails the job visibly at its own step, whereas guessing a reference could
 * resolve a parameter the definition never named.
 */
function narrowSecrets(value: unknown): Record<string, RunModelSecret> | undefined {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return undefined;
  }
  const secrets: Record<string, RunModelSecret> = {};
  for (const [envName, ref] of Object.entries(value)) {
    if (typeof ref !== 'object' || ref === null) {
      continue;
    }
    const parameter = (ref as { parameter?: unknown }).parameter;
    const scope = (ref as { scope?: unknown }).scope;
    const secretsManager = (ref as { secretsManager?: unknown }).secretsManager;
    if (typeof parameter === 'string' && parameter) {
      secrets[envName] = {
        parameter,
        ...(typeof scope === 'string' && scope ? { scope } : {}),
      };
    } else if (typeof secretsManager === 'string' && secretsManager) {
      secrets[envName] = { secretsManager };
    }
  }
  return Object.keys(secrets).length > 0 ? secrets : undefined;
}

function narrowJob(value: unknown): RunModelJob | undefined {
  if (typeof value !== 'object' || value === null) {
    return undefined;
  }
  const j = value as Record<string, unknown>;
  if (typeof j.name !== 'string' || !j.name || j.name.includes('#')) {
    return undefined;
  }
  const steps = narrowSteps(j.steps);
  if (!steps) {
    return undefined;
  }
  const dependsOn = Array.isArray(j.dependsOn)
    ? j.dependsOn.filter((d): d is string => typeof d === 'string')
    : undefined;
  const consumes = Array.isArray(j.consumes)
    ? j.consumes.flatMap((c) => {
        const job = (c as { job?: unknown })?.job;
        const artifact = (c as { artifact?: unknown })?.artifact;
        return typeof job === 'string' && typeof artifact === 'string' ? [{ job, artifact }] : [];
      })
    : undefined;
  const compute =
    typeof j.compute === 'object' && j.compute !== null
      ? (j.compute as RunModelCompute)
      : undefined;
  return {
    name: j.name,
    image: typeof j.image === 'string' ? j.image : undefined,
    compute,
    privileged: j.privileged === true,
    timeoutMinutes: typeof j.timeoutMinutes === 'number' ? j.timeoutMinutes : undefined,
    attempts: typeof j.attempts === 'number' ? j.attempts : undefined,
    steps,
    dependsOn,
    consumes,
    env:
      typeof j.env === 'object' && j.env !== null && !Array.isArray(j.env)
        ? Object.fromEntries(
            Object.entries(j.env as Record<string, unknown>).flatMap(([k, v]) =>
              typeof v === 'string' ? [[k, v]] : [],
            ),
          )
        : undefined,
    produces: narrowArtifacts(j.produces),
    cache: narrowCache(j.cache),
    secrets: narrowSecrets(j.secrets),
  };
}

/**
 * Narrow a parsed `model.json` document to the shape the decider consumes.
 * Throws {@link RunModelError} on anything uninterpretable — a model that
 * fails here failed post-synth validation's job, and the decider must refuse
 * to guess rather than run a DAG it cannot see.
 */
export function parseRunModel(document: unknown): RunModel {
  if (typeof document !== 'object' || document === null || Array.isArray(document)) {
    throw new RunModelError('model.json must be a JSON object');
  }
  const doc = document as Record<string, unknown>;
  if (typeof doc.schemaVersion !== 'number') {
    throw new RunModelError('model.json is missing a numeric schemaVersion');
  }
  if (typeof doc.repo !== 'string' || !doc.repo) {
    throw new RunModelError('model.json is missing its repo');
  }
  if (!Array.isArray(doc.workflows)) {
    throw new RunModelError('model.json is missing its workflows array');
  }
  const workflows: RunModelWorkflow[] = [];
  for (const entry of doc.workflows) {
    if (typeof entry !== 'object' || entry === null) {
      throw new RunModelError('model.json contains a non-object workflow entry');
    }
    const wf = entry as Record<string, unknown>;
    if (typeof wf.name !== 'string' || !wf.name) {
      throw new RunModelError('model.json contains a workflow without a name');
    }
    if (!Array.isArray(wf.jobs)) {
      throw new RunModelError(`workflow "${wf.name}" has no jobs array`);
    }
    const jobs: RunModelJob[] = [];
    for (const jobEntry of wf.jobs) {
      const job = narrowJob(jobEntry);
      if (!job) {
        throw new RunModelError(`workflow "${wf.name}" has an uninterpretable job entry`);
      }
      jobs.push(job);
    }
    workflows.push({
      name: wf.name,
      deadlineMinutes: typeof wf.deadlineMinutes === 'number' ? wf.deadlineMinutes : undefined,
      jobs,
    });
  }
  return {
    schemaVersion: doc.schemaVersion,
    repo: doc.repo,
    sha: typeof doc.sha === 'string' ? doc.sha : undefined,
    workflows,
  };
}
