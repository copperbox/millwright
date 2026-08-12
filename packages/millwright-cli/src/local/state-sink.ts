import * as fs from 'node:fs';
import * as path from 'node:path';
import {
  DeciderJobState,
  DispatchInputValue,
  JobStatus,
  RunStatus,
  SkipReason,
  StepStatus,
  TriggerKind,
} from '@copperbox/millwright-state';

/**
 * `StateSink` — where run/job/step state lands (spec §14): DynamoDB rows in
 * the cloud, `.millwright/runs/local-N.json` here. The local host is a
 * single process, so writes are plain mutations flushed atomically
 * (write-temp + rename); the shapes mirror the state-table items minus their
 * key/TTL attributes so `runs show` renders both from the same code.
 */

export interface LocalRunState {
  readonly repo: string;
  readonly workflow: string;
  /** The N of `local-N` — also the run number inside `MILLWRIGHT_RUN_ID`. */
  readonly runNumber: number;
  status: RunStatus;
  readonly trigger: TriggerKind;
  readonly ref: string;
  readonly sha: string;
  readonly createdAt: string;
  startedAt?: string;
  finishedAt?: string;
  cancelRequested?: boolean;
  readonly inputs?: Readonly<Record<string, DispatchInputValue>>;
}

export interface LocalJobState {
  readonly job: string;
  status: JobStatus;
  attempts?: number;
  dispatchedAt?: string;
  startedAt?: string;
  finishedAt?: string;
  skipReason?: SkipReason;
  /** Local run id whose out/ fed this job instead of executing it. */
  reusedFrom?: string;
  /** Container name of the current attempt. */
  container?: string;
  exitCode?: number;
}

export interface LocalStepState {
  readonly job: string;
  readonly stepIndex: number;
  status: StepStatus;
  name?: string;
  reason?: Extract<SkipReason, 'skip_if'>;
  startedAt?: string;
  finishedAt?: string;
}

export interface LocalRunFile {
  readonly schemaVersion: 1;
  readonly id: string;
  readonly run: LocalRunState;
  readonly jobs: LocalJobState[];
  readonly steps: LocalStepState[];
}

export interface StateSink {
  markJob(job: string, status: JobStatus, skipReason?: SkipReason): void;
  claimDispatch(job: string, container: string): void;
  recordJobStarted(job: string): void;
  recordJobFinished(job: string, status: JobStatus, exitCode?: number): void;
  seedReusedJob(job: string, reusedFrom: string): void;
  putStep(step: LocalStepState): void;
  setCancelRequested(): void;
  finishRun(status: RunStatus): void;
  flush(): void;
}

export interface NewLocalRun {
  readonly id: string;
  readonly repo: string;
  readonly workflow: string;
  readonly ref: string;
  readonly sha: string;
  readonly inputs?: Readonly<Record<string, DispatchInputValue>>;
}

export class LocalStateSink implements StateSink {
  private readonly file: LocalRunFile;

  constructor(
    private readonly stateFile: string,
    init: NewLocalRun,
    private readonly now: () => Date = () => new Date(),
  ) {
    const createdAt = this.now().toISOString();
    this.file = {
      schemaVersion: 1,
      id: init.id,
      run: {
        repo: init.repo,
        workflow: init.workflow,
        runNumber: Number(init.id.replace(/^local-/, '')),
        status: 'RUNNING',
        trigger: 'dispatch',
        ref: init.ref,
        sha: init.sha,
        createdAt,
        startedAt: createdAt,
        ...(init.inputs && Object.keys(init.inputs).length > 0 ? { inputs: init.inputs } : {}),
      },
      jobs: [],
      steps: [],
    };
    this.flush();
  }

  get state(): LocalRunFile {
    return this.file;
  }

  private job(name: string): LocalJobState {
    let job = this.file.jobs.find((j) => j.job === name);
    if (!job) {
      job = { job: name, status: 'PENDING' };
      this.file.jobs.push(job);
    }
    return job;
  }

  markJob(name: string, status: JobStatus, skipReason?: SkipReason): void {
    const job = this.job(name);
    job.status = status;
    if (skipReason) {
      job.skipReason = skipReason;
    }
    if (!job.finishedAt) {
      job.finishedAt = this.now().toISOString();
    }
  }

  claimDispatch(name: string, container: string): void {
    const job = this.job(name);
    job.attempts = (job.attempts ?? 0) + 1;
    job.dispatchedAt = this.now().toISOString();
    job.status = 'QUEUED';
    job.container = container;
    delete job.startedAt;
    delete job.finishedAt;
    delete job.skipReason;
    delete job.exitCode;
  }

  recordJobStarted(name: string): void {
    const job = this.job(name);
    job.status = 'RUNNING';
    job.startedAt = this.now().toISOString();
  }

  recordJobFinished(name: string, status: JobStatus, exitCode?: number): void {
    const job = this.job(name);
    job.status = status;
    job.finishedAt = this.now().toISOString();
    if (exitCode !== undefined) {
      job.exitCode = exitCode;
    }
  }

  seedReusedJob(name: string, reusedFrom: string): void {
    const job = this.job(name);
    job.status = 'SUCCEEDED';
    job.reusedFrom = reusedFrom;
  }

  putStep(step: LocalStepState): void {
    const existing = this.file.steps.find(
      (s) => s.job === step.job && s.stepIndex === step.stepIndex,
    );
    if (!existing) {
      this.file.steps.push({ ...step });
      return;
    }
    existing.status = step.status;
    if (step.name !== undefined) {
      existing.name = step.name;
    }
    if (step.reason !== undefined) {
      existing.reason = step.reason;
    }
    if (step.startedAt !== undefined) {
      existing.startedAt = step.startedAt;
    }
    if (step.finishedAt !== undefined) {
      existing.finishedAt = step.finishedAt;
    }
  }

  setCancelRequested(): void {
    this.file.run.cancelRequested = true;
  }

  finishRun(status: RunStatus): void {
    this.file.run.status = status;
    this.file.run.finishedAt = this.now().toISOString();
  }

  /** The decider's view of one job, from what this sink has recorded. */
  deciderState(job: string): DeciderJobState | undefined {
    const row = this.file.jobs.find((j) => j.job === job);
    if (!row) {
      return undefined;
    }
    return {
      attempts: row.attempts ?? 0,
      buildId: row.container,
      dispatchedAt: row.dispatchedAt ? Date.parse(row.dispatchedAt) : undefined,
      tableStatus: row.status,
      skipReason: row.skipReason,
      reusedFrom: row.reusedFrom,
    };
  }

  flush(): void {
    const temp = `${this.stateFile}.tmp`;
    fs.mkdirSync(path.dirname(this.stateFile), { recursive: true });
    fs.writeFileSync(temp, `${JSON.stringify(this.file, null, 2)}\n`);
    fs.renameSync(temp, this.stateFile);
  }
}

export class LocalRunFileError extends Error {}

/** Read one local run's state file, defensively narrowed for display. */
export function readLocalRunFile(stateFile: string): LocalRunFile {
  let raw: string;
  try {
    raw = fs.readFileSync(stateFile, 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
      throw new LocalRunFileError(`no local run state at ${stateFile}`);
    }
    throw err;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new LocalRunFileError(`${stateFile} is not valid JSON`);
  }
  const doc = parsed as Partial<LocalRunFile>;
  if (
    typeof doc !== 'object' ||
    doc === null ||
    doc.schemaVersion !== 1 ||
    typeof doc.id !== 'string' ||
    typeof doc.run !== 'object' ||
    !Array.isArray(doc.jobs) ||
    !Array.isArray(doc.steps)
  ) {
    throw new LocalRunFileError(`${stateFile} does not look like a local run state file`);
  }
  return doc as LocalRunFile;
}
