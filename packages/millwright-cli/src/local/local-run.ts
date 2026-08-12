import * as fs from 'node:fs';
import * as path from 'node:path';
import {
  BuildOutcome,
  DeciderJobState,
  DispatchInputValue,
  JobStatus,
  RunModelJob,
  RunModelWorkflow,
  RunStatus,
  CACHE_URI_ENV,
  OUT_URI_ENV,
  SHIM_DIR_ENV,
  SOURCE_OBJECT_NAME,
  STEP_EVENTS_FILE_ENV,
  buildspecForJob,
  decide,
  formatRunId,
  isReservedEnvName,
  jobDependencies,
  parseRunModel,
  validateStepEvent,
  workflowFromModel,
} from '@copperbox/millwright-state';
import * as millwrightWorkflows from '@copperbox/millwright-workflows';
import {
  RunModel as SynthRunModel,
  SynthError,
  WorkflowSet,
  formatDiagnostic,
  synthesize,
} from '@copperbox/millwright-workflows';
import { CommandError } from '../config-plane';
import { loadDefinition } from '../definition-loader';
import { createHashFilesResolver } from '../hash-files';
import {
  CONTAINER_CACHE,
  CONTAINER_EVENTS,
  CONTAINER_OUT,
  CONTAINER_SHIM,
  Executor,
  LocalExecution,
} from './executor';
import {
  LocalLayout,
  LocalRunPaths,
  allocateLocalRun,
  findLocalRoot,
  listLocalRunNumbers,
  localLayout,
  localRunPaths,
} from './local-layout';
import { declaredManualInputs, parseInputArgs, resolveLocalInputs } from './local-inputs';
import { renderLocalScript } from './local-script';
import { loadLocalSecrets, missingSecrets, secretEnvForJob } from './secrets-env';
import { GitRunner, createSourceArchive } from './source-archive';
import { LocalRunFile, LocalStateSink, readLocalRunFile } from './state-sink';

/**
 * `millwright run <wf>` — always local (spec §14). One thin host around the
 * shared core: the same synthesizer builds the model, the same buildspec
 * renderer authors each job's phases, the same pure decider drives the DAG
 * (SKIPPED semantics, retries, terminal states), and the same step shim
 * reports step status — against `Executor` (docker run) and `StateSink`
 * (`.millwright/runs/local-N.json`) instead of CodeBuild and DynamoDB.
 * Ctrl-C sets `cancelRequested` through the same decider path a cloud
 * `runs cancel` does. Concurrency groups are carried in the model but not
 * enforced locally; trigger predicates are never evaluated.
 */

export const DEFAULT_DEFINITION_ENTRY = path.join('millwright', 'workflows.ts');

/** Buildspec context for local rendering: no deployment, SSM never read. */
const LOCAL_DEPLOYMENT_NAME = 'local';

export interface LocalRunOptions {
  readonly workflow: string;
  /** Run one job (`--job`), its `consumes` fed from prior local runs. */
  readonly job?: string;
  /** With `--job`: run the ancestor subgraph instead of reusing artifacts. */
  readonly withDeps?: boolean;
  /** Archive `git archive HEAD` instead of the working tree. */
  readonly clean?: boolean;
  readonly platform?: string;
  readonly secretsFile?: string;
  readonly input?: readonly string[];
  /** Fake a tag ref: `--as-tag v9.9.9-test`. */
  readonly asTag?: string;
  readonly parallel?: number;
  /** Definition entry point, relative to the clone root. */
  readonly entry?: string;
}

export interface LocalRunDeps {
  readonly output: (line: string) => void;
  readonly git: GitRunner;
  readonly executor: Executor;
  readonly shimDir: string;
  readonly cwd: string;
  /** Absent means non-interactive: required inputs must come from --input. */
  readonly promptLine?: (question: string) => Promise<string>;
  /** Registers a cancellation (Ctrl-C) handler; returns the unregister. */
  readonly onCancel: (handler: () => void) => () => void;
  readonly defaultParallel: number;
  readonly now?: () => Date;
  /** Decider loop tick while jobs run. @default 200 */
  readonly pollMs?: number;
}

export interface LocalRunResult {
  readonly id: string;
  readonly status: Extract<RunStatus, 'SUCCEEDED' | 'FAILED' | 'CANCELLED'>;
  readonly stateFile: string;
}

interface RunIdentity {
  readonly root: string;
  readonly repo: string;
  readonly sha: string;
  /** `<sha>-dirty` when the working tree differs from HEAD. */
  readonly displaySha: string;
  readonly ref: string;
  /** Short ref name for the synthesizer's lints. */
  readonly shortRef: string;
}

function sanitizeRepoSegment(segment: string): string {
  const cleaned = segment.replace(/[^A-Za-z0-9._-]/g, '-');
  return cleaned || 'checkout';
}

async function resolveIdentity(
  deps: LocalRunDeps,
  options: LocalRunOptions,
): Promise<RunIdentity> {
  const root = findLocalRoot(deps.cwd);
  let sha: string;
  try {
    sha = (await deps.git(['rev-parse', 'HEAD'], root)).toString('utf8').trim();
  } catch {
    throw new CommandError(
      `local runs need a git checkout with a HEAD commit — ${root} has none`,
    );
  }
  const porcelain = (await deps.git(['status', '--porcelain'], root)).toString('utf8').trim();
  const dirty = porcelain.length > 0;

  let repo: string | undefined;
  try {
    const url = (await deps.git(['remote', 'get-url', 'origin'], root)).toString('utf8').trim();
    repo = repoFromRemote(url);
  } catch {
    repo = undefined;
  }
  repo ??= `local/${sanitizeRepoSegment(path.basename(root))}`;

  let shortRef: string;
  let ref: string;
  if (options.asTag) {
    shortRef = options.asTag;
    ref = `refs/tags/${options.asTag}`;
  } else {
    const branch = (await deps.git(['rev-parse', '--abbrev-ref', 'HEAD'], root))
      .toString('utf8')
      .trim();
    shortRef = branch === 'HEAD' ? sha.slice(0, 8) : branch;
    ref = branch === 'HEAD' ? 'HEAD' : `refs/heads/${branch}`;
  }
  return { root, repo, sha, displaySha: dirty ? `${sha}-dirty` : sha, ref, shortRef };
}

/** `git@github.com:o/r.git`, `https://…/o/r.git`, `ssh://…/o/r` → `o/r`. */
function repoFromRemote(url: string): string | undefined {
  const segments = url
    .replace(/\.git$/, '')
    .split(/[/:]/)
    .filter((s) => s.length > 0);
  if (segments.length < 2) {
    return undefined;
  }
  const [owner, name] = segments.slice(-2);
  if (!owner || !name || owner.includes('@') || /^(https?|ssh|git)$/.test(owner)) {
    return undefined;
  }
  return `${owner}/${name}`;
}

function isWorkflowSetLike(value: unknown): value is WorkflowSet {
  return (
    typeof value === 'object' &&
    value !== null &&
    Array.isArray((value as { workflows?: unknown }).workflows)
  );
}

function synthModel(
  deps: LocalRunDeps,
  identity: RunIdentity,
  entryPath: string,
  workflow: string,
  dispatchInputs?: Record<string, DispatchInputValue>,
): SynthRunModel {
  const definition = loadDefinition(entryPath, {
    fallbackModules: { '@copperbox/millwright-workflows': millwrightWorkflows },
  });
  if (!(definition instanceof WorkflowSet) && !isWorkflowSetLike(definition)) {
    throw new CommandError(
      `${path.relative(identity.root, entryPath)} must default-export a WorkflowSet, got ` +
        `${definition === undefined ? 'no default export' : typeof definition}`,
    );
  }
  try {
    const { model, diagnostics } = synthesize(definition as WorkflowSet, {
      repo: identity.repo,
      commit: identity.sha,
      ref: identity.shortRef,
      resolveHashFiles: createHashFilesResolver(identity.root),
      ...(dispatchInputs ? { dispatch: { workflow, inputs: dispatchInputs } } : {}),
    });
    for (const diagnostic of diagnostics) {
      if (diagnostic.level === 'warning') {
        deps.output(formatDiagnostic(diagnostic));
      }
    }
    return model;
  } catch (err) {
    if (err instanceof SynthError) {
      for (const diagnostic of err.diagnostics) {
        deps.output(formatDiagnostic(diagnostic));
      }
      throw new CommandError('synth failed — no run model to execute');
    }
    throw err;
  }
}

interface JobSelection {
  /** Jobs this run executes. */
  readonly execute: readonly RunModelJob[];
  /** Producers outside the selection, satisfied from prior local runs. */
  readonly seeded: readonly RunModelJob[];
  /** The decider's model: executed + seeded jobs, edges confined to them. */
  readonly workflow: RunModelWorkflow;
}

/** Transitive dependency closure of one job (ancestors + itself). */
function ancestorClosure(workflow: RunModelWorkflow, job: string): Set<string> {
  const byName = new Map(workflow.jobs.map((j) => [j.name, j]));
  const closure = new Set<string>();
  const queue = [job];
  while (queue.length > 0) {
    const name = queue.shift()!;
    if (closure.has(name)) {
      continue;
    }
    closure.add(name);
    const model = byName.get(name);
    for (const dep of model ? jobDependencies(model) : []) {
      queue.push(dep);
    }
  }
  return closure;
}

function selectJobs(workflow: RunModelWorkflow, options: LocalRunOptions): JobSelection {
  if (!options.job) {
    return { execute: workflow.jobs, seeded: [], workflow };
  }
  const byName = new Map(workflow.jobs.map((j) => [j.name, j]));
  if (!byName.has(options.job)) {
    throw new CommandError(
      `workflow "${workflow.name}" has no job "${options.job}" ` +
        `(has: ${workflow.jobs.map((j) => j.name).join(', ')})`,
    );
  }
  const selected = options.withDeps
    ? ancestorClosure(workflow, options.job)
    : new Set([options.job]);

  // Producers of consumed artifacts outside the selection are seeded from
  // prior local runs; pure ordering edges to unselected jobs are dropped —
  // the operator asked for exactly this subgraph.
  const seededNames = new Set<string>();
  for (const name of selected) {
    for (const consumed of byName.get(name)!.consumes ?? []) {
      if (!selected.has(consumed.job)) {
        seededNames.add(consumed.job);
      }
    }
  }
  const keep = new Set([...selected, ...seededNames]);
  const jobs = workflow.jobs
    .filter((job) => keep.has(job.name))
    .map((job) => ({
      ...job,
      dependsOn: (job.dependsOn ?? []).filter((dep) => keep.has(dep)),
    }));
  return {
    execute: jobs.filter((job) => selected.has(job.name)),
    seeded: jobs.filter((job) => seededNames.has(job.name)),
    workflow: { ...workflow, jobs },
  };
}

interface ArtifactDonor {
  readonly runId: string;
  readonly outDir: string;
  readonly finishedAt?: string;
}

/**
 * Newest prior local run whose state shows `job` SUCCEEDED and whose out/
 * still holds the artifact directory.
 */
function findArtifactDonor(
  layout: LocalLayout,
  job: string,
  artifact: string,
): ArtifactDonor | undefined {
  const numbers = listLocalRunNumbers(layout).reverse();
  for (const number of numbers) {
    const paths = localRunPaths(layout, `local-${number}`);
    let state: LocalRunFile;
    try {
      state = readLocalRunFile(paths.stateFile);
    } catch {
      continue;
    }
    const row = state.jobs.find((j) => j.job === job);
    if (row?.status !== 'SUCCEEDED') {
      continue;
    }
    const artifactDir = path.join(paths.outDir, job, artifact);
    if (!fs.existsSync(artifactDir)) {
      continue;
    }
    return { runId: paths.id, outDir: paths.outDir, finishedAt: row.finishedAt };
  }
  return undefined;
}

function age(fromIso: string | undefined, now: Date): string {
  if (!fromIso) {
    return '';
  }
  const minutes = Math.max(0, Math.round((now.getTime() - Date.parse(fromIso)) / 60000));
  if (minutes < 60) {
    return `, ${minutes}m ago`;
  }
  const hours = Math.floor(minutes / 60);
  return hours < 48 ? `, ${hours}h ago` : `, ${Math.floor(hours / 24)}d ago`;
}

function formatRunDuration(ms: number): string {
  const seconds = Math.max(0, Math.round(ms / 1000));
  const minutes = Math.floor(seconds / 60);
  if (minutes === 0) {
    return `${seconds}s`;
  }
  const hours = Math.floor(minutes / 60);
  if (hours === 0) {
    return `${minutes}m ${String(seconds % 60).padStart(2, '0')}s`;
  }
  return `${hours}h ${String(minutes % 60).padStart(2, '0')}m`;
}

const OUTCOME_TO_JOB_STATUS: Partial<Record<BuildOutcome, JobStatus>> = {
  SUCCEEDED: 'SUCCEEDED',
  FAILED: 'FAILED',
  TIMED_OUT: 'TIMED_OUT',
  STOPPED: 'CANCELLED',
};

export async function localRun(
  deps: LocalRunDeps,
  options: LocalRunOptions,
): Promise<LocalRunResult> {
  const now = deps.now ?? (() => new Date());
  const identity = await resolveIdentity(deps, options);
  const layout = localLayout(identity.root);
  const entryPath = path.resolve(identity.root, options.entry ?? DEFAULT_DEFINITION_ENTRY);

  // Synth in-process: first without dispatch to read the declared inputs,
  // then (for manual workflows) with the typed dispatch values so factories
  // and defaults resolve exactly as a cloud dispatch would.
  let model = synthModel(deps, identity, entryPath, options.workflow);
  const workflowModel = model.workflows.find((wf) => wf.name === options.workflow);
  if (!workflowModel) {
    throw new CommandError(
      `no workflow "${options.workflow}" in ${path.relative(identity.root, entryPath)} ` +
        `(has: ${model.workflows.map((wf) => wf.name).join(', ')})`,
    );
  }
  const declared = declaredManualInputs(workflowModel);
  const inputs = await resolveLocalInputs({
    workflow: options.workflow,
    raw: parseInputArgs(options.input ?? []),
    declared,
    promptLine: deps.promptLine,
  });
  if (declared) {
    model = synthModel(deps, identity, entryPath, options.workflow, inputs);
  }

  // The same defensive narrowing the cloud applies at the model.json
  // boundary — the decider never runs a DAG it cannot see.
  const runModel = parseRunModel(JSON.parse(JSON.stringify(model)));
  const workflow = workflowFromModel(runModel, options.workflow);
  deps.output(
    `● synth  ${path.relative(identity.root, entryPath)} → ` +
      `${workflow.jobs.length} job${workflow.jobs.length === 1 ? '' : 's'} (in-process)`,
  );

  const selection = selectJobs(workflow, options);

  // Secrets preflight: fail closed before any job starts (spec §14).
  const secrets = loadLocalSecrets(options.secretsFile, layout.defaultSecretsFile);
  const missing = missingSecrets(selection.execute, secrets);
  if (missing.length > 0) {
    deps.output(
      `✖ ${missing.length} declared secret${missing.length === 1 ? '' : 's'} not present in your local env:`,
    );
    for (const item of missing) {
      deps.output(`    ${item.env}  (${item.ref}, job ${item.job})`);
    }
    deps.output(
      `  Provide them in ${path.relative(deps.cwd, layout.defaultSecretsFile)} (gitignored) ` +
        'or --secrets-file <path>. Local runs never read SSM/Secrets Manager.',
    );
    throw new CommandError('missing local secrets — nothing was run');
  }

  await deps.executor.preflight();

  // Artifact reuse: resolve donors for every seeded consumption BEFORE the
  // run allocates state, so a missing artifact costs nothing.
  const seededNames = new Set(selection.seeded.map((job) => job.name));
  const donors = new Map<string, ArtifactDonor>();
  const reuseLines: string[] = [];
  for (const job of selection.execute) {
    for (const consumed of job.consumes ?? []) {
      if (!seededNames.has(consumed.job)) {
        continue;
      }
      const donorKey = `${consumed.job}/${consumed.artifact}`;
      if (donors.has(donorKey)) {
        continue;
      }
      const donor = findArtifactDonor(layout, consumed.job, consumed.artifact);
      if (!donor) {
        throw new CommandError(
          `${job.name} consumes ${consumed.job}.${consumed.artifact} — no local artifacts found; ` +
            `run 'millwright run ${options.workflow} --job ${consumed.job}' first, ` +
            'use --with-deps, or drop --job',
        );
      }
      donors.set(donorKey, donor);
      reuseLines.push(
        `  reusing ${consumed.job}.${consumed.artifact} from ${donor.runId}` +
          `${age(donor.finishedAt, now())}`,
      );
    }
  }

  const paths = allocateLocalRun(layout);
  const sink = new LocalStateSink(
    paths.stateFile,
    {
      id: paths.id,
      repo: identity.repo,
      workflow: options.workflow,
      ref: identity.ref,
      sha: identity.displaySha,
      inputs,
    },
    now,
  );
  const runId = formatRunId({
    repo: identity.repo,
    workflow: options.workflow,
    runNumber: sink.state.run.runNumber,
  });

  deps.output(
    `● plan   ${selection.execute.map((job) => job.name).join(', ')}` +
      (selection.seeded.length > 0
        ? `   (reused: ${selection.seeded.map((job) => job.name).join(', ')})`
        : ''),
  );
  for (const line of reuseLines) {
    deps.output(line);
  }

  // The run's in/ mirrors the cloud prefix: model.json + source.tar.gz.
  fs.writeFileSync(path.join(paths.inDir, 'model.json'), `${JSON.stringify(model, null, 2)}\n`);
  const sourceFile = path.join(paths.inDir, SOURCE_OBJECT_NAME);
  const archive = await createSourceArchive(deps.git, {
    root: identity.root,
    clean: options.clean === true,
    outFile: sourceFile,
  });
  deps.output(
    options.clean
      ? '● source git archive HEAD (--clean)'
      : `● source working tree (${archive.fileCount} files)`,
  );

  // Seed reused producers and copy their artifacts into this run's out/.
  for (const job of selection.seeded) {
    const donorIds = new Set<string>();
    for (const [key, donor] of donors) {
      if (key.startsWith(`${job.name}/`)) {
        const artifact = key.slice(job.name.length + 1);
        fs.cpSync(
          path.join(donor.outDir, job.name, artifact),
          path.join(paths.outDir, job.name, artifact),
          { recursive: true },
        );
        donorIds.add(donor.runId);
      }
    }
    sink.seedReusedJob(job.name, [...donorIds].join(',') || 'prior run');
  }

  if (selection.execute.some((job) => job.privileged)) {
    deps.output(
      '● note   privileged jobs mount the host docker socket — fidelity differs from cloud dind',
    );
  }

  const result = await driveRun(deps, {
    options,
    identity,
    layout,
    paths,
    sink,
    runId,
    workflow: selection.workflow,
    executeNames: new Set(selection.execute.map((job) => job.name)),
    secretsEnv: (job: RunModelJob) => secretEnvForJob(job, secrets),
    now,
  });
  return result;
}

interface DriveContext {
  readonly options: LocalRunOptions;
  readonly identity: RunIdentity;
  readonly layout: LocalLayout;
  readonly paths: LocalRunPaths;
  readonly sink: LocalStateSink;
  readonly runId: string;
  readonly workflow: RunModelWorkflow;
  readonly executeNames: ReadonlySet<string>;
  readonly secretsEnv: (job: RunModelJob) => Record<string, string>;
  readonly now: () => Date;
}

/** Ingests one job's step-event JSON lines as the shim appends them. */
class StepEventTail {
  private offset = 0;

  constructor(
    private readonly file: string,
    private readonly runId: string,
  ) {}

  drain(sink: LocalStateSink): void {
    let content: string;
    try {
      content = fs.readFileSync(this.file, 'utf8');
    } catch {
      return;
    }
    if (content.length <= this.offset) {
      return;
    }
    const fresh = content.slice(this.offset);
    const lastNewline = fresh.lastIndexOf('\n');
    if (lastNewline < 0) {
      return;
    }
    this.offset += lastNewline + 1;
    for (const line of fresh.slice(0, lastNewline).split('\n')) {
      if (!line.trim()) {
        continue;
      }
      let parsed: { source?: string; 'detail-type'?: string; detail?: unknown };
      try {
        parsed = JSON.parse(line);
      } catch {
        continue;
      }
      const validated = validateStepEvent(
        parsed.source ?? '',
        parsed['detail-type'] ?? '',
        parsed.detail,
      );
      if (!validated.ok || formatRunId(validated.event.coords) !== this.runId) {
        continue;
      }
      const event = validated.event;
      sink.putStep({
        job: event.job,
        stepIndex: event.stepIndex,
        status: event.status,
        name: event.name,
        reason: event.reason,
        startedAt: event.startedAt,
        finishedAt: event.finishedAt,
      });
    }
  }
}

async function driveRun(deps: LocalRunDeps, ctx: DriveContext): Promise<LocalRunResult> {
  const { sink, paths, workflow } = ctx;
  const pollMs = deps.pollMs ?? 200;
  const parallel = ctx.options.parallel ?? deps.defaultParallel;
  if (!Number.isInteger(parallel) || parallel < 1) {
    throw new CommandError(`--parallel must be a positive integer, got ${parallel}`);
  }

  const running = new Map<string, LocalExecution>();
  const outcomes = new Map<string, BuildOutcome>();
  const tails = new Map<string, StepEventTail>();
  const startedAtMs = new Map<string, number>();
  const announcedMarks = new Set<string>();
  let cancelRequested = false;
  let cancelAnnounced = false;
  const anchorMs = Date.parse(sink.state.run.createdAt);

  let wake: (() => void) | undefined;
  const wakeUp = () => {
    wake?.();
    wake = undefined;
  };
  const unregisterCancel = deps.onCancel(() => {
    cancelRequested = true;
    sink.setCancelRequested();
    wakeUp();
  });

  const jobsByName = new Map(workflow.jobs.map((job) => [job.name, job]));

  const dispatchJob = (name: string, attempt: number): void => {
    const job = jobsByName.get(name)!;
    const container = `millwright-${paths.id}-${name}-${attempt}`.replace(/[^a-zA-Z0-9_.-]/g, '-');
    const workDir = path.join(paths.workDir, name);
    fs.rmSync(workDir, { recursive: true, force: true });
    fs.mkdirSync(workDir, { recursive: true });
    fs.copyFileSync(path.join(paths.inDir, SOURCE_OBJECT_NAME), path.join(workDir, SOURCE_OBJECT_NAME));

    const scriptFile = path.join(paths.scriptsDir, `${name}.sh`);
    fs.writeFileSync(
      scriptFile,
      renderLocalScript(
        buildspecForJob(job, { deploymentName: LOCAL_DEPLOYMENT_NAME, repo: ctx.identity.repo }),
      ),
    );

    const eventsFile = path.join(paths.eventsDir, `${name}.jsonl`);
    tails.set(name, new StepEventTail(eventsFile, ctx.runId));

    const declaredEnv = Object.fromEntries(
      Object.entries(job.env ?? {}).filter(([key]) => !isReservedEnvName(key)),
    );
    const env: Record<string, string> = {
      ...declaredEnv,
      ...ctx.secretsEnv(job),
      MILLWRIGHT_RUN_ID: ctx.runId,
      MILLWRIGHT_JOB: name,
      MILLWRIGHT_SHA: ctx.identity.displaySha,
      MILLWRIGHT_REF: ctx.identity.ref,
      [OUT_URI_ENV]: CONTAINER_OUT,
      [CACHE_URI_ENV]: CONTAINER_CACHE,
      [SHIM_DIR_ENV]: CONTAINER_SHIM,
      [STEP_EVENTS_FILE_ENV]: `${CONTAINER_EVENTS}/${name}.jsonl`,
    };

    outcomes.delete(name);
    sink.claimDispatch(name, container);
    const execution = deps.executor.start({
      job: name,
      image: job.image ?? '',
      container,
      workDir,
      outDir: paths.outDir,
      cacheDir: ctx.layout.cacheDir,
      shimDir: deps.shimDir,
      eventsFile,
      scriptFile,
      env,
      platform: ctx.options.platform,
      privileged: job.privileged === true,
      timeoutMinutes: job.timeoutMinutes,
    });
    running.set(name, execution);
    sink.recordJobStarted(name);
    startedAtMs.set(name, ctx.now().getTime());
    deps.output(`▶ ${name}  ${job.image ?? ''}`.trimEnd());

    void execution.outcome.then((outcome) => {
      running.delete(name);
      outcomes.set(name, outcome);
      const status = OUTCOME_TO_JOB_STATUS[outcome];
      const duration = formatRunDuration(ctx.now().getTime() - (startedAtMs.get(name) ?? 0));
      if (status) {
        sink.recordJobFinished(name, status);
        deps.output(`${status === 'SUCCEEDED' ? '✔' : '✖'} ${name}  ${status}  ${duration}`);
      } else {
        deps.output(`✖ ${name}  infrastructure fault — docker could not run the job`);
      }
      wakeUp();
    });
  };

  try {
    for (;;) {
      for (const tail of tails.values()) {
        tail.drain(sink);
      }

      const states: Record<string, DeciderJobState> = {};
      for (const job of workflow.jobs) {
        const base = sink.deciderState(job.name);
        if (!base) {
          continue;
        }
        const outcome = outcomes.get(job.name) ?? (running.has(job.name) ? 'IN_PROGRESS' : undefined);
        states[job.name] = outcome ? { ...base, buildOutcome: outcome } : base;
      }

      const nowMs = ctx.now().getTime();
      const actions = decide(workflow, states, cancelRequested, { nowMs, anchorMs });

      if (cancelRequested && !cancelAnnounced) {
        cancelAnnounced = true;
        deps.output(
          `● cancel stopping ${running.size} running job${running.size === 1 ? '' : 's'}…`,
        );
      }

      for (const mark of actions.markJobs) {
        sink.markJob(mark.job, mark.status, mark.skipReason);
        const key = `${mark.job}:${mark.status}:${mark.skipReason ?? ''}`;
        if (!announcedMarks.has(key) && !running.has(mark.job)) {
          announcedMarks.add(key);
          if (mark.status === 'SKIPPED') {
            deps.output(
              `○ ${mark.job}  SKIPPED` +
                (mark.skipReason === 'upstream_failed' ? ' (upstream failed)' : ''),
            );
          } else if (mark.status !== 'CANCELLED') {
            deps.output(`✖ ${mark.job}  ${mark.status}`);
          }
        }
      }

      for (const stop of actions.stopBuilds) {
        void running.get(stop.job)?.stop();
      }

      if (actions.runStatus !== 'RUNNING') {
        // In-flight containers were just told to stop; wait for them so the
        // terminal states on disk reflect reality before we return.
        if (running.size > 0) {
          await Promise.all([...running.values()].map((execution) => execution.outcome));
        }
        for (const tail of tails.values()) {
          tail.drain(sink);
        }
        sink.finishRun(actions.runStatus);
        sink.flush();
        const totals = { ok: 0, skipped: 0, cancelled: 0, failed: 0 };
        for (const job of sink.state.jobs) {
          if (job.status === 'SUCCEEDED') {
            totals.ok += 1;
          } else if (job.status === 'SKIPPED') {
            totals.skipped += 1;
          } else if (job.status === 'CANCELLED') {
            totals.cancelled += 1;
          } else {
            totals.failed += 1;
          }
        }
        const duration = formatRunDuration(ctx.now().getTime() - anchorMs);
        const jobCount = sink.state.jobs.length;
        const parts = [
          `${totals.ok} ok`,
          ...(totals.skipped ? [`${totals.skipped} skipped`] : []),
          ...(totals.cancelled ? [`${totals.cancelled} cancelled`] : []),
          ...(totals.failed ? [`${totals.failed} failed`] : []),
        ];
        deps.output(
          `Run ${paths.id} ${actions.runStatus} in ${duration}   ` +
            `(${jobCount} job${jobCount === 1 ? '' : 's'}: ${parts.join(', ')})`,
        );
        return { id: paths.id, status: actions.runStatus, stateFile: paths.stateFile };
      }

      const slots = Math.max(0, parallel - running.size);
      for (const name of actions.dispatch.slice(0, slots)) {
        const attempts = states[name]?.attempts ?? 0;
        dispatchJob(name, attempts + 1);
      }

      sink.flush();
      await new Promise<void>((resolve) => {
        wake = resolve;
        setTimeout(resolve, pollMs).unref?.();
      });
    }
  } finally {
    unregisterCancel();
    for (const tail of tails.values()) {
      tail.drain(sink);
    }
    sink.flush();
  }
}
