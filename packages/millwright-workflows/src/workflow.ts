import { Trigger } from './trigger';
import { Artifact, Cache, Compute, Secret, StepsProp } from './values';

/** Job names the control plane reserves for its own check contexts. */
export const RESERVED_JOB_NAMES: readonly string[] = ['synth'];

const NAME_PATTERN = /^[a-z0-9][a-z0-9._-]*$/i;

function assertValidName(kind: 'workflow' | 'job', name: string): void {
  if (!name || !NAME_PATTERN.test(name)) {
    throw new Error(
      `Invalid ${kind} name "${name}": names must start with a letter or digit ` +
        'and contain only letters, digits, ".", "_" or "-"',
    );
  }
}

export interface ConcurrencyProps {
  /** Group key; `${repo}` style placeholders resolve at synth. */
  readonly group: string;
  /** queue: pending slot of one. supersede: cancel the running run. */
  readonly policy: 'queue' | 'supersede';
}

/** Image/compute defaults cascade job > Workflow > WorkflowSet; image has no built-in default. */
export interface DefaultsProps {
  readonly image?: string;
  readonly compute?: Compute;
}

export interface WorkflowProps extends DefaultsProps {
  readonly on: readonly Trigger[];
  readonly concurrency?: ConcurrencyProps;
}

export interface TimeoutProps {
  readonly minutes: number;
}

export interface JobProps extends DefaultsProps {
  readonly steps: StepsProp;
  readonly compute?: Compute;
  readonly privileged?: boolean;
  readonly timeout?: TimeoutProps;
  readonly secrets?: Record<string, Secret>;
  readonly produces?: Record<string, Artifact>;
  readonly consumes?: Record<string, ArtifactRef>;
  readonly dependsOn?: readonly Job[];
  readonly cache?: Cache;
}

/** Handle to another job's produced artifact; consuming one is the DAG edge. */
export class ArtifactRef {
  constructor(
    readonly job: Job,
    readonly artifactName: string,
    readonly artifact: Artifact,
  ) {}
}

export class Job {
  /** Typed handles to this job's produced artifacts, keyed by artifact name. */
  readonly artifacts: Record<string, ArtifactRef> = {};

  constructor(
    readonly workflow: Workflow,
    readonly name: string,
    readonly props: JobProps,
  ) {
    assertValidName('job', name);
    for (const [artifactName, artifact] of Object.entries(props.produces ?? {})) {
      this.artifacts[artifactName] = new ArtifactRef(this, artifactName, artifact);
    }
  }
}

export class Workflow {
  readonly jobs: Job[] = [];

  constructor(
    readonly set: WorkflowSet,
    readonly name: string,
    readonly props: WorkflowProps,
  ) {
    assertValidName('workflow', name);
    if (!props?.on || props.on.length === 0) {
      throw new Error(`Workflow "${name}" needs at least one trigger in "on"`);
    }
    set._register(this);
  }

  job(name: string, props: JobProps): Job {
    if (RESERVED_JOB_NAMES.includes(name)) {
      throw new Error(`Job name "${name}" is reserved by millwright`);
    }
    if (this.jobs.some((j) => j.name === name)) {
      throw new Error(`Workflow "${this.name}" already has a job named "${name}"`);
    }
    const job = new Job(this, name, props);
    this.jobs.push(job);
    return job;
  }
}

/** Root of a repo's definition; `millwright/workflows.ts` default-exports one. */
export class WorkflowSet {
  readonly workflows: Workflow[] = [];

  constructor(readonly defaults: DefaultsProps = {}) {}

  /** @internal */
  _register(workflow: Workflow): void {
    if (this.workflows.some((w) => w.name === workflow.name)) {
      throw new Error(`WorkflowSet already has a workflow named "${workflow.name}"`);
    }
    this.workflows.push(workflow);
  }
}
