/**
 * Run-model schema validation, shared between synth (which asserts its own
 * output) and the control plane (which re-validates `model.json` after the
 * synth job wrote it — the synth job runs repo-controlled code, so nothing it
 * emits is trusted until this check passes).
 */

import { RunModel } from './model';
import { RESERVED_JOB_NAMES } from './workflow';

export interface ValidationIssue {
  /** JSON-pointer-ish location, e.g. `workflows[0].jobs[2].image`. */
  readonly path: string;
  readonly message: string;
}

export interface ValidationResult {
  readonly ok: boolean;
  readonly issues: readonly ValidationIssue[];
}

export interface ValidateOptions {
  /**
   * The validating control plane's own supported schema version. A model with
   * a newer `schemaVersion` is rejected — the skew contract is model <= plane.
   */
  readonly controlPlaneSchemaVersion?: number;
}

export class RunModelValidationError extends Error {
  constructor(readonly issues: readonly ValidationIssue[]) {
    super(
      `Invalid run model (${issues.length} issue${issues.length === 1 ? '' : 's'}):\n` +
        issues.map((i) => `  ${i.path}: ${i.message}`).join('\n'),
    );
    this.name = 'RunModelValidationError';
  }
}

const NAME_PATTERN = /^[a-z0-9][a-z0-9._-]*$/i;
const TRIGGER_KINDS = ['push', 'tag', 'pull_request', 'cron', 'manual'];
const COMPUTE_ARCHES = ['arm64', 'x86_64'];
const COMPUTE_SIZES = ['small', 'medium', 'large'];
const CONCURRENCY_POLICIES = ['queue', 'supersede'];

class Checker {
  readonly issues: ValidationIssue[] = [];

  fail(path: string, message: string): void {
    this.issues.push({ path, message });
  }

  isRecord(value: unknown, path: string, what: string): value is Record<string, unknown> {
    if (typeof value !== 'object' || value === null || Array.isArray(value)) {
      this.fail(path, `${what} must be an object`);
      return false;
    }
    return true;
  }

  isArray(value: unknown, path: string, what: string): value is unknown[] {
    if (!Array.isArray(value)) {
      this.fail(path, `${what} must be an array`);
      return false;
    }
    return true;
  }

  nonEmptyString(value: unknown, path: string, what: string): value is string {
    if (typeof value !== 'string' || value.trim() === '') {
      this.fail(path, `${what} must be a non-empty string`);
      return false;
    }
    return true;
  }

  stringArray(value: unknown, path: string, what: string): value is string[] {
    if (!this.isArray(value, path, what)) {
      return false;
    }
    let ok = true;
    value.forEach((item, i) => {
      if (!this.nonEmptyString(item, `${path}[${i}]`, `${what} entry`)) {
        ok = false;
      }
    });
    return ok;
  }

  validName(value: unknown, path: string, what: string): value is string {
    if (!this.nonEmptyString(value, path, what)) {
      return false;
    }
    if (!NAME_PATTERN.test(value)) {
      this.fail(
        path,
        `${what} "${value}" must start with a letter or digit and contain only ` +
          'letters, digits, ".", "_" or "-"',
      );
      return false;
    }
    return true;
  }
}

function checkTrigger(c: Checker, trigger: unknown, path: string): void {
  if (!c.isRecord(trigger, path, 'trigger')) {
    return;
  }
  const kind = trigger.kind;
  if (typeof kind !== 'string' || !TRIGGER_KINDS.includes(kind)) {
    c.fail(`${path}.kind`, `trigger kind must be one of ${TRIGGER_KINDS.join(', ')}`);
    return;
  }
  switch (kind) {
    case 'push':
      if (trigger.branches !== undefined) {
        c.stringArray(trigger.branches, `${path}.branches`, 'branches');
      }
      break;
    case 'tag':
      c.nonEmptyString(trigger.pattern, `${path}.pattern`, 'tag pattern');
      break;
    case 'cron':
      c.nonEmptyString(trigger.expression, `${path}.expression`, 'cron expression');
      break;
    case 'manual': {
      if (!c.isRecord(trigger.inputs, `${path}.inputs`, 'manual inputs')) {
        break;
      }
      for (const [name, input] of Object.entries(trigger.inputs)) {
        const inputPath = `${path}.inputs.${name}`;
        if (!c.isRecord(input, inputPath, 'manual input')) {
          continue;
        }
        if (input.type === 'boolean') {
          if (input.default !== undefined && typeof input.default !== 'boolean') {
            c.fail(`${inputPath}.default`, 'boolean input default must be a boolean');
          }
        } else if (input.type === 'choice') {
          if (
            c.stringArray(input.choices, `${inputPath}.choices`, 'choices') &&
            input.choices.length === 0
          ) {
            c.fail(`${inputPath}.choices`, 'choice input needs at least one choice');
          }
          if (
            input.default !== undefined &&
            Array.isArray(input.choices) &&
            !input.choices.includes(input.default)
          ) {
            c.fail(`${inputPath}.default`, `default "${input.default}" is not one of the choices`);
          }
        } else {
          c.fail(`${inputPath}.type`, 'manual input type must be "choice" or "boolean"');
        }
      }
      break;
    }
    case 'pull_request':
      break;
  }
}

function checkSecret(c: Checker, secret: unknown, path: string): void {
  if (!c.isRecord(secret, path, 'secret')) {
    return;
  }
  if ('parameter' in secret) {
    c.nonEmptyString(secret.parameter, `${path}.parameter`, 'secret parameter name');
    if (secret.scope !== undefined) {
      c.nonEmptyString(secret.scope, `${path}.scope`, 'secret scope');
    }
  } else if ('secretsManager' in secret) {
    if (
      c.nonEmptyString(secret.secretsManager, `${path}.secretsManager`, 'secret ARN') &&
      !secret.secretsManager.startsWith('arn:')
    ) {
      c.fail(`${path}.secretsManager`, `"${secret.secretsManager}" is not a Secrets Manager ARN`);
    }
  } else {
    c.fail(path, 'secret must carry "parameter" or "secretsManager"');
  }
}

/**
 * The key arrives fully resolved (spec §12: `hashFiles` is evaluated at
 * synth) and becomes one S3 object name under `cache/<repo>/`; restore keys
 * are prefixes of keys, so both get the same character discipline.
 */
function checkCacheKey(c: Checker, value: unknown, path: string, what: string): void {
  if (!c.nonEmptyString(value, path, what)) {
    return;
  }
  if (value.includes('..') || value.includes('/')) {
    c.fail(path, `${what} "${value}" must not contain "/" or ".."`);
  }
}

function checkCache(c: Checker, cache: unknown, path: string): void {
  if (!c.isRecord(cache, path, 'cache')) {
    return;
  }
  checkCacheKey(c, cache.key, `${path}.key`, 'cache key');
  if (c.stringArray(cache.paths, `${path}.paths`, 'cache paths') && cache.paths.length === 0) {
    c.fail(`${path}.paths`, 'cache needs at least one path');
  }
  if (cache.restoreKeys !== undefined && c.isArray(cache.restoreKeys, `${path}.restoreKeys`, 'restoreKeys')) {
    cache.restoreKeys.forEach((key, i) => {
      checkCacheKey(c, key, `${path}.restoreKeys[${i}]`, 'restore key');
    });
  }
}

function checkJob(c: Checker, job: Record<string, unknown>, path: string): void {
  c.nonEmptyString(job.image, `${path}.image`, 'image');
  if (c.isRecord(job.compute, `${path}.compute`, 'compute')) {
    if (!COMPUTE_ARCHES.includes(job.compute.arch as string)) {
      c.fail(`${path}.compute.arch`, `compute arch must be one of ${COMPUTE_ARCHES.join(', ')}`);
    }
    if (!COMPUTE_SIZES.includes(job.compute.size as string)) {
      c.fail(`${path}.compute.size`, `compute size must be one of ${COMPUTE_SIZES.join(', ')}`);
    }
  }
  if (typeof job.privileged !== 'boolean') {
    c.fail(`${path}.privileged`, 'privileged must be a boolean');
  }
  if (job.timeoutMinutes !== undefined) {
    if (!Number.isInteger(job.timeoutMinutes) || (job.timeoutMinutes as number) <= 0) {
      c.fail(`${path}.timeoutMinutes`, 'timeoutMinutes must be a positive integer');
    }
  }
  if (c.isArray(job.steps, `${path}.steps`, 'steps')) {
    if (job.steps.length === 0) {
      c.fail(`${path}.steps`, 'job needs at least one step');
    }
    job.steps.forEach((step, i) => {
      const stepPath = `${path}.steps[${i}]`;
      if (!c.isRecord(step, stepPath, 'step')) {
        return;
      }
      c.nonEmptyString(step.run, `${stepPath}.run`, 'step command');
      if (step.skipIf !== undefined) {
        c.nonEmptyString(step.skipIf, `${stepPath}.skipIf`, 'skipIf command');
      }
    });
  }
  if (job.secrets !== undefined && c.isRecord(job.secrets, `${path}.secrets`, 'secrets')) {
    for (const [name, secret] of Object.entries(job.secrets)) {
      checkSecret(c, secret, `${path}.secrets.${name}`);
    }
  }
  if (job.produces !== undefined && c.isArray(job.produces, `${path}.produces`, 'produces')) {
    const seen = new Set<string>();
    job.produces.forEach((artifact, i) => {
      const artifactPath = `${path}.produces[${i}]`;
      if (!c.isRecord(artifact, artifactPath, 'artifact')) {
        return;
      }
      // The name becomes the `out/<job>/<name>/` prefix segment (§9.3).
      if (c.validName(artifact.name, `${artifactPath}.name`, 'artifact name')) {
        if (seen.has(artifact.name)) {
          c.fail(`${artifactPath}.name`, `duplicate artifact name "${artifact.name}"`);
        }
        seen.add(artifact.name);
      }
      if (
        c.stringArray(artifact.paths, `${artifactPath}.paths`, 'artifact paths') &&
        artifact.paths.length === 0
      ) {
        c.fail(`${artifactPath}.paths`, 'artifact needs at least one path');
      }
    });
  }
  if (job.consumes !== undefined && c.isArray(job.consumes, `${path}.consumes`, 'consumes')) {
    job.consumes.forEach((ref, i) => {
      const refPath = `${path}.consumes[${i}]`;
      if (!c.isRecord(ref, refPath, 'artifact reference')) {
        return;
      }
      c.nonEmptyString(ref.job, `${refPath}.job`, 'producing job name');
      c.nonEmptyString(ref.artifact, `${refPath}.artifact`, 'artifact name');
    });
  }
  c.stringArray(job.dependsOn, `${path}.dependsOn`, 'dependsOn');
  if (job.cache !== undefined) {
    checkCache(c, job.cache, `${path}.cache`);
  }
}

/** Cross-job checks: consumes/dependsOn edges resolve, and the DAG is acyclic. */
function checkWorkflowGraph(c: Checker, workflow: Record<string, unknown>, path: string): void {
  const jobs = workflow.jobs as unknown[];
  const jobByName = new Map<string, Record<string, unknown>>();
  for (const job of jobs) {
    const record = job as Record<string, unknown>;
    if (typeof record?.name === 'string') {
      jobByName.set(record.name, record);
    }
  }

  const edges = new Map<string, Set<string>>();
  jobs.forEach((job, i) => {
    const record = job as Record<string, unknown>;
    const name = record?.name;
    if (typeof name !== 'string') {
      return;
    }
    const deps = new Set<string>();
    if (Array.isArray(record.consumes)) {
      record.consumes.forEach((refValue, r) => {
        const ref = refValue as Record<string, unknown>;
        const producerName = ref?.job;
        if (typeof producerName !== 'string') {
          return;
        }
        const producer = jobByName.get(producerName);
        const refPath = `${path}.jobs[${i}].consumes[${r}]`;
        if (!producer) {
          c.fail(
            refPath,
            `consumes artifact "${ref.artifact}" from job "${producerName}", which is not a job ` +
              `in workflow "${workflow.name}" — consumes only reaches jobs in the same workflow`,
          );
          return;
        }
        const produces = Array.isArray(producer.produces) ? producer.produces : [];
        const produced = produces.some(
          (artifact) => (artifact as Record<string, unknown>)?.name === ref.artifact,
        );
        if (typeof ref.artifact !== 'string' || !produced) {
          c.fail(
            refPath,
            `consumes artifact "${ref.artifact}" which job "${producerName}" does not produce — ` +
              'every consumes needs a matching produces',
          );
          return;
        }
        deps.add(producerName);
      });
    }
    if (Array.isArray(record.dependsOn)) {
      record.dependsOn.forEach((dep, d) => {
        if (typeof dep !== 'string') {
          return;
        }
        if (!jobByName.has(dep)) {
          c.fail(
            `${path}.jobs[${i}].dependsOn[${d}]`,
            `depends on "${dep}", which is not a job in workflow "${workflow.name}"`,
          );
          return;
        }
        deps.add(dep);
      });
    }
    edges.set(name, deps);
  });

  const state = new Map<string, 'visiting' | 'done'>();
  const stack: string[] = [];
  const visit = (name: string): string[] | undefined => {
    const s = state.get(name);
    if (s === 'done') {
      return undefined;
    }
    if (s === 'visiting') {
      return [...stack.slice(stack.indexOf(name)), name];
    }
    state.set(name, 'visiting');
    stack.push(name);
    for (const dep of edges.get(name) ?? []) {
      const cycle = visit(dep);
      if (cycle) {
        return cycle;
      }
    }
    stack.pop();
    state.set(name, 'done');
    return undefined;
  };
  for (const name of edges.keys()) {
    const cycle = visit(name);
    if (cycle) {
      c.fail(
        `${path}.jobs`,
        `dependency cycle in workflow "${workflow.name}": ${cycle.join(' -> ')} — ` +
          'the consumes/dependsOn graph must be acyclic',
      );
      break;
    }
  }
}

/**
 * Validate an untrusted run-model document. Returns every issue found rather
 * than stopping at the first.
 */
export function validateRunModel(value: unknown, options: ValidateOptions = {}): ValidationResult {
  const c = new Checker();
  if (!c.isRecord(value, '$', 'run model')) {
    return { ok: false, issues: c.issues };
  }

  if (!Number.isInteger(value.schemaVersion) || (value.schemaVersion as number) <= 0) {
    c.fail('schemaVersion', 'schemaVersion must be a positive integer');
  } else if (
    options.controlPlaneSchemaVersion !== undefined &&
    (value.schemaVersion as number) > options.controlPlaneSchemaVersion
  ) {
    c.fail(
      'schemaVersion',
      `run model schemaVersion ${value.schemaVersion} is newer than this control plane supports ` +
        `(${options.controlPlaneSchemaVersion}) — upgrade the deployed control plane, or pin the ` +
        "repo's @copperbox/millwright-workflows to a matching version",
    );
  }

  if (
    c.nonEmptyString(value.repo, 'repo', 'repo') &&
    !/^[^/\s]+\/[^/\s]+$/.test(value.repo)
  ) {
    c.fail('repo', `repo must be "owner/name", got "${value.repo}"`);
  }
  c.nonEmptyString(value.commit, 'commit', 'commit');

  if (!c.isArray(value.workflows, 'workflows', 'workflows')) {
    return { ok: c.issues.length === 0, issues: c.issues };
  }

  const workflowNames = new Set<string>();
  value.workflows.forEach((workflow, w) => {
    const path = `workflows[${w}]`;
    if (!c.isRecord(workflow, path, 'workflow')) {
      return;
    }
    if (c.validName(workflow.name, `${path}.name`, 'workflow name')) {
      if (workflowNames.has(workflow.name)) {
        c.fail(`${path}.name`, `duplicate workflow name "${workflow.name}"`);
      }
      workflowNames.add(workflow.name);
    }
    if (c.isArray(workflow.triggers, `${path}.triggers`, 'triggers')) {
      if (workflow.triggers.length === 0) {
        c.fail(`${path}.triggers`, 'workflow needs at least one trigger');
      }
      workflow.triggers.forEach((trigger, t) => checkTrigger(c, trigger, `${path}.triggers[${t}]`));
    }
    if (workflow.concurrency !== undefined) {
      const concurrencyPath = `${path}.concurrency`;
      if (c.isRecord(workflow.concurrency, concurrencyPath, 'concurrency')) {
        c.nonEmptyString(workflow.concurrency.group, `${concurrencyPath}.group`, 'concurrency group');
        if (!CONCURRENCY_POLICIES.includes(workflow.concurrency.policy as string)) {
          c.fail(
            `${concurrencyPath}.policy`,
            `concurrency policy must be one of ${CONCURRENCY_POLICIES.join(', ')}`,
          );
        }
      }
    }
    if (c.isArray(workflow.jobs, `${path}.jobs`, 'jobs')) {
      const jobNames = new Set<string>();
      workflow.jobs.forEach((job, j) => {
        const jobPath = `${path}.jobs[${j}]`;
        if (!c.isRecord(job, jobPath, 'job')) {
          return;
        }
        if (c.validName(job.name, `${jobPath}.name`, 'job name')) {
          if (RESERVED_JOB_NAMES.includes(job.name)) {
            c.fail(
              `${jobPath}.name`,
              `job name "${job.name}" is reserved by millwright (it is a control-plane check context)`,
            );
          }
          if (jobNames.has(job.name)) {
            c.fail(`${jobPath}.name`, `duplicate job name "${job.name}" in workflow "${workflow.name}"`);
          }
          jobNames.add(job.name);
        }
        checkJob(c, job, jobPath);
      });
      checkWorkflowGraph(c, workflow, path);
    }
  });

  return { ok: c.issues.length === 0, issues: c.issues };
}

/** Validate and narrow; throws `RunModelValidationError` listing every issue. */
export function assertValidRunModel(
  value: unknown,
  options: ValidateOptions = {},
): asserts value is RunModel {
  const result = validateRunModel(value, options);
  if (!result.ok) {
    throw new RunModelValidationError(result.issues);
  }
}
