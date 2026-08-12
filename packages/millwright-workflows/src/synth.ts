/**
 * The synth compiler: a `WorkflowSet` object graph in, one run-model JSON
 * document out, plus every synth-time error and lint the spec pins (§4.3).
 *
 * Synth makes no registry or network calls — image lints are string-level
 * only — and `secretsAllowedRefs` checking here is fail-fast UX, never
 * enforcement (that is the decider's, at dispatch).
 */

import { CronParseError, minCronIntervalMinutes } from './cron';
import { Diagnostic, SynthError } from './diagnostics';
import {
  ArtifactModel,
  ArtifactRefModel,
  CacheKeyPartModel,
  CacheModel,
  JobModel,
  ManualInputModel,
  RunModel,
  SecretModel,
  StepModel,
  TriggerModel,
  WorkflowModel,
} from './model';
import { matchesAnyRefPattern } from './refs';
import { SCHEMA_VERSION } from './schema';
import { ManualInput, Trigger } from './trigger';
import { validateRunModel } from './validate';
import { Compute, Secret, StepInput } from './values';
import { Job, Workflow, WorkflowSet } from './workflow';

export interface DispatchOptions {
  /** Workflow being manually dispatched. */
  readonly workflow: string;
  /** Typed input values; declared defaults fill whatever is omitted. */
  readonly inputs?: Readonly<Record<string, unknown>>;
}

export interface SynthOptions {
  /** `owner/repo` identity of the watched repository. */
  readonly repo: string;
  /** Commit sha the definition is synthesized at. */
  readonly commit: string;
  /**
   * Short name of the triggering ref (`main`, `release/1.2`); enables the
   * fail-fast secrets-refs lint when `secretsAllowedRefs` is also given.
   */
  readonly ref?: string;
  /**
   * The deployed control plane's supported schema version. Cloud synth passes
   * it; a newer model fails loud here instead of at validation time.
   */
  readonly controlPlaneSchemaVersion?: number;
  /** Deployment poll cadence in minutes; enables the cron granularity lint (cloud synth). */
  readonly pollCadenceMinutes?: number;
  /** The repo's `secretsAllowedRefs` config, for the fail-fast lint only. */
  readonly secretsAllowedRefs?: readonly string[];
  /** Present when synthesizing for a manual dispatch. */
  readonly dispatch?: DispatchOptions;
}

export interface SynthResult {
  readonly model: RunModel;
  /** Warning-level lints; errors throw `SynthError` instead. */
  readonly diagnostics: readonly Diagnostic[];
}

const CONCURRENCY_TOKENS = ['repo', 'ref', 'workflow', 'event'];

/**
 * True when the image name pins a registry host (first path segment has a
 * dot, a port, or is "localhost"). `node:22` and `myorg/app:1` are implicit
 * Docker Hub references.
 */
function hasExplicitRegistry(image: string): boolean {
  const firstSegment = image.split('/')[0];
  return (
    image.includes('/') &&
    (firstSegment.includes('.') || firstSegment.includes(':') || firstSegment === 'localhost')
  );
}

function toSecretModel(secret: Secret): SecretModel {
  if (secret.kind === 'named') {
    return secret.scope !== undefined
      ? { kind: 'named', name: secret.ref, scope: secret.scope }
      : { kind: 'named', name: secret.ref };
  }
  return { kind: 'secretsManager', arn: secret.ref };
}

function toManualInputModel(input: ManualInput): ManualInputModel {
  if ('choices' in input) {
    return input.default !== undefined
      ? { type: 'choice', choices: [...input.choices], default: input.default }
      : { type: 'choice', choices: [...input.choices] };
  }
  return input.default !== undefined
    ? { type: 'boolean', default: input.default }
    : { type: 'boolean' };
}

function manualInputDefault(input: ManualInput): unknown {
  if ('choices' in input) {
    return input.default;
  }
  return input.default ?? false;
}

class Synthesizer {
  private readonly diagnostics: Diagnostic[] = [];
  private jobsWithSecrets: string[] = [];

  constructor(
    private readonly set: WorkflowSet,
    private readonly options: SynthOptions,
  ) {}

  private error(code: string, message: string, where: { workflow?: string; job?: string } = {}): void {
    this.diagnostics.push({ level: 'error', code, message, ...where });
  }

  private warn(code: string, message: string, where: { workflow?: string; job?: string } = {}): void {
    this.diagnostics.push({ level: 'warning', code, message, ...where });
  }

  synthesize(): SynthResult {
    const { options } = this;
    if (
      options.controlPlaneSchemaVersion !== undefined &&
      SCHEMA_VERSION > options.controlPlaneSchemaVersion
    ) {
      this.error(
        'schema-version-skew',
        `this definition library emits run-model schemaVersion ${SCHEMA_VERSION}, but the deployed ` +
          `control plane supports at most ${options.controlPlaneSchemaVersion} — upgrade the ` +
          "deployed control plane, or pin the repo's @copperbox/millwright-workflows to a matching version",
      );
    }
    if (!options.repo || !/^[^/\s]+\/[^/\s]+$/.test(options.repo)) {
      this.error('invalid-repo', `repo must be "owner/name", got "${options.repo}"`);
    }
    if (!options.commit || !options.commit.trim()) {
      this.error('invalid-commit', 'commit must be a non-empty sha');
    }

    const dispatch = options.dispatch;
    if (dispatch && !this.set.workflows.some((w) => w.name === dispatch.workflow)) {
      this.error(
        'unknown-dispatch-workflow',
        `cannot dispatch workflow "${dispatch.workflow}": no workflow with that name is defined`,
      );
    }

    const workflows = this.set.workflows.map((workflow) => this.synthWorkflow(workflow));

    if (this.jobsWithSecrets.length > 0) {
      this.warn(
        'secret-masking-exact-match',
        `secret masking is exact-match-only: values of secrets declared on ${this.jobsWithSecrets.join(
          ', ',
        )} leak into logs if a step transforms them (base64, substring, re-encode) before printing`,
      );
    }

    const model: RunModel = {
      schemaVersion: SCHEMA_VERSION,
      repo: options.repo,
      commit: options.commit,
      workflows,
    };

    // Construction-level problems (unresolvable image, bad inputs) leave
    // placeholder-free holes the validator would double-report; only run the
    // model-level validation once construction itself was clean.
    if (!this.diagnostics.some((d) => d.level === 'error')) {
      const result = validateRunModel(model, {
        controlPlaneSchemaVersion: options.controlPlaneSchemaVersion,
      });
      for (const issue of result.issues) {
        this.error('invalid-model', `${issue.path}: ${issue.message}`);
      }
    }

    if (this.diagnostics.some((d) => d.level === 'error')) {
      throw new SynthError(this.diagnostics);
    }
    return { model, diagnostics: this.diagnostics };
  }

  private synthWorkflow(workflow: Workflow): WorkflowModel {
    const where = { workflow: workflow.name };
    const triggers = workflow.props.on.map((trigger) => this.synthTrigger(workflow, trigger));

    let concurrency;
    if (workflow.props.concurrency) {
      const { group, policy } = workflow.props.concurrency;
      concurrency = { group, policy };
      for (const match of group.matchAll(/\$\{([^}]*)\}/g)) {
        if (!CONCURRENCY_TOKENS.includes(match[1])) {
          this.warn(
            'unknown-concurrency-token',
            `concurrency group "${group}" uses \${${match[1]}}, which the launcher does not ` +
              `substitute — known tokens are ${CONCURRENCY_TOKENS.map((t) => `\${${t}}`).join(', ')}`,
            where,
          );
        }
      }
    }

    const inputs = this.resolveInputs(workflow);
    const jobs = workflow.jobs.map((job) => this.synthJob(workflow, job, inputs));
    return concurrency
      ? { name: workflow.name, triggers, concurrency, jobs }
      : { name: workflow.name, triggers, jobs };
  }

  private synthTrigger(workflow: Workflow, trigger: Trigger): TriggerModel {
    const where = { workflow: workflow.name };
    switch (trigger.kind) {
      case 'push': {
        const branches = trigger.config.branches as readonly string[] | undefined;
        return branches ? { kind: 'push', branches: [...branches] } : { kind: 'push' };
      }
      case 'tag':
        return { kind: 'tag', pattern: trigger.config.pattern as string };
      case 'pull_request':
        return { kind: 'pull_request' };
      case 'cron': {
        const expression = trigger.config.expression as string;
        try {
          const interval = minCronIntervalMinutes(expression);
          const cadence = this.options.pollCadenceMinutes;
          if (cadence !== undefined && interval < cadence) {
            this.warn(
              'cron-finer-than-poll-cadence',
              `Trigger.cron("${expression}") can fire every ${interval} minute${
                interval === 1 ? '' : 's'
              }, but this deployment polls every ${cadence} — cron granularity degrades to the ` +
                'poll cadence',
              where,
            );
          }
        } catch (err) {
          if (!(err instanceof CronParseError)) {
            throw err;
          }
          this.error('invalid-cron', `Trigger.cron("${expression}"): ${err.message}`, where);
        }
        return { kind: 'cron', expression };
      }
      case 'manual': {
        const declared = trigger.config.inputs as Record<string, ManualInput>;
        const inputs: Record<string, ManualInputModel> = {};
        for (const [name, input] of Object.entries(declared)) {
          if ('choices' in input && input.default !== undefined && !input.choices.includes(input.default)) {
            this.error(
              'invalid-input-default',
              `manual input "${name}" defaults to "${input.default}", which is not one of its choices`,
              where,
            );
          }
          inputs[name] = toManualInputModel(input);
        }
        return { kind: 'manual', inputs };
      }
    }
  }

  /**
   * Effective input values a `steps: (inputs) => [...]` factory sees:
   * declared defaults, overlaid with dispatch values when this workflow is
   * the one being dispatched (values type-checked against the declaration).
   */
  private resolveInputs(workflow: Workflow): Record<string, unknown> {
    const where = { workflow: workflow.name };
    const declared: Record<string, ManualInput> = {};
    for (const trigger of workflow.props.on) {
      if (trigger.kind === 'manual') {
        Object.assign(declared, trigger.config.inputs as Record<string, ManualInput>);
      }
    }

    const values: Record<string, unknown> = {};
    for (const [name, input] of Object.entries(declared)) {
      values[name] = manualInputDefault(input);
    }

    const dispatch = this.options.dispatch;
    if (!dispatch || dispatch.workflow !== workflow.name) {
      return values;
    }
    if (!workflow.props.on.some((t) => t.kind === 'manual')) {
      this.error(
        'not-manually-dispatchable',
        `workflow "${workflow.name}" has no Trigger.manual and cannot be dispatched`,
        where,
      );
      return values;
    }
    for (const [name, value] of Object.entries(dispatch.inputs ?? {})) {
      const input = declared[name];
      if (!input) {
        this.error(
          'unknown-input',
          `dispatch input "${name}" is not declared on workflow "${workflow.name}" — declared ` +
            `inputs: ${Object.keys(declared).join(', ') || '(none)'}`,
          where,
        );
        continue;
      }
      if ('choices' in input) {
        if (typeof value !== 'string' || !input.choices.includes(value)) {
          this.error(
            'invalid-input-value',
            `dispatch input "${name}" must be one of ${input.choices.join(', ')}, got ${JSON.stringify(
              value,
            )}`,
            where,
          );
          continue;
        }
      } else if (typeof value !== 'boolean') {
        this.error(
          'invalid-input-value',
          `dispatch input "${name}" must be a boolean, got ${JSON.stringify(value)}`,
          where,
        );
        continue;
      }
      values[name] = value;
    }
    for (const [name, input] of Object.entries(declared)) {
      if (values[name] === undefined && 'choices' in input) {
        this.error(
          'missing-input',
          `dispatch input "${name}" has no default and no value was provided — pass one of ` +
            input.choices.join(', '),
          where,
        );
      }
    }
    return values;
  }

  private synthJob(workflow: Workflow, job: Job, inputs: Record<string, unknown>): JobModel {
    const where = { workflow: workflow.name, job: job.name };
    const props = job.props;

    const image = props.image ?? workflow.props.image ?? this.set.defaults.image;
    if (image === undefined || !image.trim()) {
      this.error(
        'image-unresolved',
        `job "${job.name}" has no image: millwright has no default — set image on the job, ` +
          `its Workflow, or the WorkflowSet`,
        where,
      );
    } else if (!hasExplicitRegistry(image)) {
      const recommendation = image.includes('/')
        ? 'pull through an explicit registry you control (e.g. your own ECR)'
        : `prefer the mirror: public.ecr.aws/docker/library/${image}`;
      this.warn(
        'implicit-docker-hub',
        `image "${image}" is an implicit Docker Hub reference (rate-limited, mutable); ${recommendation}`,
        where,
      );
    }

    const compute: Compute =
      props.compute ?? workflow.props.compute ?? this.set.defaults.compute ?? Compute.ARM_SMALL;

    if (props.timeout !== undefined) {
      if (!Number.isInteger(props.timeout.minutes) || props.timeout.minutes <= 0) {
        this.error(
          'invalid-timeout',
          `timeout must be a positive whole number of minutes, got ${props.timeout.minutes}`,
          where,
        );
      }
    }

    const steps = this.resolveSteps(job, inputs, where);

    const secrets: Record<string, SecretModel> = {};
    for (const [name, secret] of Object.entries(props.secrets ?? {})) {
      secrets[name] = toSecretModel(secret);
    }
    if (Object.keys(secrets).length > 0) {
      this.jobsWithSecrets.push(`${workflow.name}/${job.name}`);
      const { ref, secretsAllowedRefs } = this.options;
      if (
        ref !== undefined &&
        secretsAllowedRefs !== undefined &&
        !matchesAnyRefPattern(ref, secretsAllowedRefs)
      ) {
        this.warn(
          'secrets-ref-not-allowed',
          `ref "${ref}" is not in the repo's secretsAllowedRefs ` +
            `[${secretsAllowedRefs.join(', ') || 'empty — no ref receives secrets'}]; the decider ` +
            'will dispatch this job without its declared secrets (this check is fail-fast UX — ' +
            'enforcement happens at dispatch)',
          where,
        );
      }
    }

    const produces: Record<string, ArtifactModel> = {};
    for (const [name, artifact] of Object.entries(props.produces ?? {})) {
      produces[name] = { kind: artifact.kind, path: artifact.path };
    }

    const consumes: Record<string, ArtifactRefModel> = {};
    for (const [name, ref] of Object.entries(props.consumes ?? {})) {
      consumes[name] = { job: ref.job.name, artifact: ref.artifactName };
      if (!workflow.jobs.includes(ref.job)) {
        this.error(
          'consumes-unmatched',
          `consumes "${name}" from job "${ref.job.name}" of workflow "${ref.job.workflow.name}" — ` +
            'consumes only reaches jobs in the same workflow',
          where,
        );
      }
    }

    const dependsOn: string[] = [];
    for (const dep of props.dependsOn ?? []) {
      dependsOn.push(dep.name);
      if (!workflow.jobs.includes(dep)) {
        this.error(
          'depends-on-unmatched',
          `dependsOn names job "${dep.name}", which is not a job of workflow "${workflow.name}"`,
          where,
        );
      }
    }

    let cache: CacheModel | undefined;
    if (props.cache) {
      const key: CacheKeyPartModel[] = props.cache.key.map((part) =>
        typeof part === 'string'
          ? { kind: 'literal', value: part }
          : { kind: 'hashFiles', patterns: [...part.patterns] },
      );
      cache = { key, paths: [...props.cache.paths], restoreKeys: [...props.cache.restoreKeys] };
    }

    const base = {
      name: job.name,
      image: image ?? '',
      compute: { arch: compute.arch, size: compute.size },
      privileged: props.privileged ?? false,
      steps,
      secrets,
      produces,
      consumes,
      dependsOn,
    };
    return {
      ...base,
      ...(props.timeout !== undefined ? { timeoutMinutes: props.timeout.minutes } : {}),
      ...(cache ? { cache } : {}),
    };
  }

  private resolveSteps(
    job: Job,
    inputs: Record<string, unknown>,
    where: { workflow: string; job: string },
  ): StepModel[] {
    let raw: readonly StepInput[];
    if (typeof job.props.steps === 'function') {
      try {
        raw = job.props.steps(inputs);
      } catch (err) {
        this.error(
          'steps-factory-failed',
          `steps factory threw: ${err instanceof Error ? err.message : String(err)}`,
          where,
        );
        return [];
      }
    } else {
      raw = job.props.steps;
    }
    if (!raw || raw.length === 0) {
      this.error('no-steps', 'job has no steps', where);
      return [];
    }
    return raw.map((step) => {
      if (typeof step === 'string') {
        return { run: step };
      }
      return step.skipIf !== undefined ? { run: step.command, skipIf: step.skipIf } : { run: step.command };
    });
  }
}

/**
 * Compile a `WorkflowSet` to the run model. Returns the model plus
 * warning-level lints; throws `SynthError` carrying every diagnostic when any
 * error-level check fires.
 */
export function synthesize(set: WorkflowSet, options: SynthOptions): SynthResult {
  return new Synthesizer(set, options).synthesize();
}
