import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { BuildOutcome } from '@copperbox/millwright-state';
import { afterEach, describe, expect, it } from 'vitest';
import { CommandError } from '../src/config-plane';
import { Executor, LocalExecution, LocalJobSpec } from '../src/local/executor';
import { LocalRunDeps, localRun } from '../src/local/local-run';
import { createGitRunner } from '../src/local/source-archive';
import { readLocalRunFile } from '../src/local/state-sink';
import { runsShowLocal } from '../src/runs';

const tmpdirs: string[] = [];

afterEach(() => {
  for (const dir of tmpdirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

function git(cwd: string, ...args: string[]): void {
  execFileSync('git', args, { cwd, env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null' } });
}

/** A committed checkout whose millwright/workflows.ts is `definition`. */
function fixtureRepo(definition: string): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'millwright-run-'));
  tmpdirs.push(root);
  git(root, 'init', '-q');
  git(root, 'config', 'user.email', 'test@example.invalid');
  git(root, 'config', 'user.name', 'test');
  fs.mkdirSync(path.join(root, 'millwright'));
  fs.writeFileSync(path.join(root, 'millwright', 'workflows.ts'), definition);
  fs.writeFileSync(path.join(root, 'app.txt'), 'app\n');
  git(root, 'add', '-A');
  git(root, 'commit', '-qm', 'init');
  return root;
}

const CI_DEFINITION = `
import { Artifact, Trigger, Workflow, WorkflowSet } from '@copperbox/millwright-workflows';

const set = new WorkflowSet({ image: 'public.ecr.aws/docker/library/node:22' });
const ci = new Workflow(set, 'ci', { on: [Trigger.push({ branches: ['main'] })] });
const build = ci.job('build', {
  steps: ['echo building'],
  produces: { dist: Artifact.dir('dist') },
});
ci.job('unit', { steps: ['echo unit'], dependsOn: [build] });
ci.job('integration', {
  consumes: { dist: build.artifacts.dist },
  steps: ['echo integration'],
});
export default set;
`;

interface JobPlan {
  /** Outcome per attempt; defaults to one SUCCEEDED. */
  readonly outcomes?: readonly BuildOutcome[];
  /** Ignore the plan and wait for stop() (cancellation tests). */
  readonly block?: boolean;
  /** Artifact names materialized under out/<job>/<name>/ on success. */
  readonly artifacts?: readonly string[];
  /** Emit step 0 as skipIf-SKIPPED (the job still succeeds), like the shim. */
  readonly skipStep?: boolean;
}

/**
 * The Executor fake: completes jobs per plan after a tick, emitting the
 * step events the real shim would (RUNNING then a terminal status for
 * step 0) into the run's events file.
 */
class FakeExecutor implements Executor {
  readonly started: LocalJobSpec[] = [];

  constructor(private readonly plans: Readonly<Record<string, JobPlan>> = {}) {}

  async preflight(): Promise<void> {}

  private emit(spec: LocalJobSpec, status: string, extra: Record<string, unknown> = {}): void {
    fs.mkdirSync(path.dirname(spec.eventsFile), { recursive: true });
    const detail = {
      runId: spec.env.MILLWRIGHT_RUN_ID,
      job: spec.job,
      stepIndex: 0,
      status,
      startedAt: '2026-08-12T01:00:00Z',
      ...extra,
    };
    fs.appendFileSync(
      spec.eventsFile,
      `${JSON.stringify({ source: 'millwright.step', 'detail-type': 'step', detail })}\n`,
    );
  }

  start(spec: LocalJobSpec): LocalExecution {
    this.started.push(spec);
    const attempt = this.started.filter((s) => s.job === spec.job).length;
    const plan = this.plans[spec.job] ?? {};
    let stopRequested = false;
    let onStop: (() => void) | undefined;

    const outcome = new Promise<BuildOutcome>((resolve) => {
      setTimeout(() => {
        if (plan.skipStep) {
          // The shim never reports RUNNING for a skipIf-skipped step.
          this.emit(spec, 'SKIPPED', { reason: 'skip_if', finishedAt: '2026-08-12T01:00:01Z' });
          resolve('SUCCEEDED');
          return;
        }
        this.emit(spec, 'RUNNING');
        if (plan.block) {
          const finish = () => {
            this.emit(spec, 'FAILED', { finishedAt: '2026-08-12T01:00:01Z' });
            resolve('STOPPED');
          };
          if (stopRequested) {
            finish();
          } else {
            onStop = finish;
          }
          return;
        }
        const result = plan.outcomes?.[attempt - 1] ?? 'SUCCEEDED';
        if (result === 'SUCCEEDED') {
          for (const artifact of plan.artifacts ?? []) {
            const dir = path.join(spec.outDir, spec.job, artifact);
            fs.mkdirSync(dir, { recursive: true });
            fs.writeFileSync(path.join(dir, 'artifact.txt'), `${spec.job}/${artifact}\n`);
          }
          this.emit(spec, 'SUCCEEDED', { finishedAt: '2026-08-12T01:00:01Z' });
        } else if (result === 'FAILED') {
          this.emit(spec, 'FAILED', { finishedAt: '2026-08-12T01:00:01Z' });
        }
        resolve(result);
      }, 5);
    });

    return {
      job: spec.job,
      container: spec.container,
      outcome,
      stop: async () => {
        stopRequested = true;
        onStop?.();
      },
    };
  }
}

interface Harness {
  readonly deps: LocalRunDeps;
  readonly lines: string[];
  readonly executor: FakeExecutor;
  cancel(): void;
}

function harness(
  root: string,
  executor: FakeExecutor,
  overrides: Partial<LocalRunDeps> = {},
): Harness {
  const lines: string[] = [];
  let cancelHandler: (() => void) | undefined;
  const deps: LocalRunDeps = {
    output: (line) => lines.push(line),
    git: createGitRunner(),
    executor,
    shimDir: '/opt/millwright/shim',
    cwd: root,
    onCancel: (handler) => {
      cancelHandler = handler;
      return () => {
        cancelHandler = undefined;
      };
    },
    defaultParallel: 4,
    pollMs: 5,
    ...overrides,
  };
  return { deps, lines, executor, cancel: () => cancelHandler?.() };
}

describe('millwright run — the local host', () => {
  it('runs a multi-job DAG to SUCCEEDED with the cloud step semantics', async () => {
    const root = fixtureRepo(CI_DEFINITION);
    const executor = new FakeExecutor({ build: { artifacts: ['dist'] } });
    const { deps, lines } = harness(root, executor);

    const result = await localRun(deps, { workflow: 'ci' });

    expect(result.status).toBe('SUCCEEDED');
    const state = readLocalRunFile(result.stateFile);
    expect(state.id).toBe('local-1');
    expect(state.run.status).toBe('SUCCEEDED');
    expect(state.jobs.map((job) => [job.job, job.status]).sort()).toEqual([
      ['build', 'SUCCEEDED'],
      ['integration', 'SUCCEEDED'],
      ['unit', 'SUCCEEDED'],
    ]);
    // Step events from the shim landed as step rows.
    expect(state.steps.filter((step) => step.status === 'SUCCEEDED')).toHaveLength(3);
    // build ran before its dependents.
    expect(executor.started[0].job).toBe('build');
    expect(executor.started).toHaveLength(3);
    expect(lines.some((line) => line.startsWith('Run local-1 SUCCEEDED'))).toBe(true);
  });

  it('a skipIf-skipped step lands as SKIPPED (reason skip_if) while its job succeeds', async () => {
    const root = fixtureRepo(CI_DEFINITION);
    const executor = new FakeExecutor({
      build: { artifacts: ['dist'] },
      unit: { skipStep: true },
    });
    const { deps } = harness(root, executor);

    const result = await localRun(deps, { workflow: 'ci' });

    expect(result.status).toBe('SUCCEEDED');
    const state = readLocalRunFile(result.stateFile);
    expect(state.jobs.find((job) => job.job === 'unit')?.status).toBe('SUCCEEDED');
    const skipped = state.steps.find((step) => step.job === 'unit');
    expect(skipped?.status).toBe('SKIPPED');
    expect(skipped?.reason).toBe('skip_if');
  });

  it('propagates a failure: dependents SKIPPED (upstream_failed), run FAILED, no auto-retry', async () => {
    const root = fixtureRepo(CI_DEFINITION);
    const executor = new FakeExecutor({ build: { outcomes: ['FAILED'] } });
    const { deps } = harness(root, executor);

    const result = await localRun(deps, { workflow: 'ci' });

    expect(result.status).toBe('FAILED');
    const state = readLocalRunFile(result.stateFile);
    const byName = new Map(state.jobs.map((job) => [job.job, job]));
    expect(byName.get('build')?.status).toBe('FAILED');
    expect(byName.get('build')?.attempts).toBe(1);
    expect(byName.get('unit')?.status).toBe('SKIPPED');
    expect(byName.get('unit')?.skipReason).toBe('upstream_failed');
    expect(byName.get('integration')?.status).toBe('SKIPPED');
    expect(executor.started).toHaveLength(1);
  });

  it('retries infrastructure faults within the attempt cap', async () => {
    const root = fixtureRepo(CI_DEFINITION);
    const executor = new FakeExecutor({
      build: { outcomes: ['FAULT', 'FAULT', 'SUCCEEDED'], artifacts: ['dist'] },
    });
    const { deps } = harness(root, executor);

    const result = await localRun(deps, { workflow: 'ci' });

    expect(result.status).toBe('SUCCEEDED');
    const state = readLocalRunFile(result.stateFile);
    expect(state.jobs.find((job) => job.job === 'build')?.attempts).toBe(3);
  });

  it('Ctrl-C cancels through cancelRequested: containers stop, states are terminal', async () => {
    const root = fixtureRepo(CI_DEFINITION);
    const executor = new FakeExecutor({ build: { block: true } });
    const h = harness(root, executor);

    const run = localRun(h.deps, { workflow: 'ci' });
    // Let the build container start, then interrupt.
    await new Promise((resolve) => setTimeout(resolve, 40));
    h.cancel();
    const result = await run;

    expect(result.status).toBe('CANCELLED');
    const state = readLocalRunFile(result.stateFile);
    expect(state.run.cancelRequested).toBe(true);
    expect(state.run.status).toBe('CANCELLED');
    for (const job of state.jobs) {
      expect(['CANCELLED']).toContain(job.status);
    }
    expect(executor.started).toHaveLength(1);
  });

  it('--job runs one job, feeding consumes from the newest prior local run', async () => {
    const root = fixtureRepo(CI_DEFINITION);
    const first = harness(root, new FakeExecutor({ build: { artifacts: ['dist'] } }));
    await localRun(first.deps, { workflow: 'ci' });

    const executor = new FakeExecutor();
    const { deps, lines } = harness(root, executor);
    const result = await localRun(deps, { workflow: 'ci', job: 'integration' });

    expect(result.status).toBe('SUCCEEDED');
    expect(executor.started.map((spec) => spec.job)).toEqual(['integration']);
    const state = readLocalRunFile(result.stateFile);
    const build = state.jobs.find((job) => job.job === 'build');
    expect(build?.status).toBe('SUCCEEDED');
    expect(build?.reusedFrom).toBe('local-1');
    // The donor's artifact was copied into this run's out/.
    expect(
      fs.readFileSync(
        path.join(root, '.millwright', 'runs', 'local-2', 'out', 'build', 'dist', 'artifact.txt'),
        'utf8',
      ),
    ).toBe('build/dist\n');
    expect(lines.some((line) => line.includes('reusing build.dist from local-1'))).toBe(true);
  });

  it('--job without prior artifacts errors, naming the producing job', async () => {
    const root = fixtureRepo(CI_DEFINITION);
    const executor = new FakeExecutor();
    const { deps } = harness(root, executor);

    await expect(localRun(deps, { workflow: 'ci', job: 'integration' })).rejects.toThrow(
      /integration consumes build\.dist — no local artifacts found/,
    );
    expect(executor.started).toHaveLength(0);
  });

  it('--job --with-deps runs the ancestor closure and nothing else', async () => {
    const root = fixtureRepo(CI_DEFINITION);
    const executor = new FakeExecutor();
    const { deps } = harness(root, executor);

    const result = await localRun(deps, { workflow: 'ci', job: 'unit', withDeps: true });

    expect(result.status).toBe('SUCCEEDED');
    expect(executor.started.map((spec) => spec.job).sort()).toEqual(['build', 'unit']);
    const state = readLocalRunFile(result.stateFile);
    expect(state.jobs.map((job) => job.job).sort()).toEqual(['build', 'unit']);
  });

  it('--parallel 1 serializes independent jobs', async () => {
    const root = fixtureRepo(CI_DEFINITION);
    const executor = new FakeExecutor({ build: { artifacts: ['dist'] } });
    const { deps } = harness(root, executor);

    await localRun(deps, { workflow: 'ci', parallel: 1 });

    // unit and integration are both ready after build; with one slot they
    // must have started one at a time (3 jobs, 3 sequential starts).
    expect(executor.started).toHaveLength(3);
  });

  it('fails before any job starts when declared secrets are missing locally', async () => {
    const root = fixtureRepo(`
import { Secret, Trigger, Workflow, WorkflowSet } from '@copperbox/millwright-workflows';
const set = new WorkflowSet({ image: 'public.ecr.aws/docker/library/node:22' });
const release = new Workflow(set, 'release', { on: [Trigger.tag({ pattern: 'v*' })] });
release.job('publish', {
  steps: ['npm publish'],
  secrets: { NPM_TOKEN: Secret.named('npm-token') },
});
export default set;
`);
    const executor = new FakeExecutor();
    const { deps, lines } = harness(root, executor);

    await expect(localRun(deps, { workflow: 'release' })).rejects.toThrow(CommandError);
    expect(executor.started).toHaveLength(0);
    expect(lines.some((line) => line.includes('NPM_TOKEN'))).toBe(true);
    expect(fs.existsSync(path.join(root, '.millwright', 'runs', 'local-1.json'))).toBe(false);
  });

  it('resolves typed inputs from --input and prompts for required omissions', async () => {
    const root = fixtureRepo(`
import { Trigger, Workflow, WorkflowSet } from '@copperbox/millwright-workflows';
const set = new WorkflowSet({ image: 'public.ecr.aws/docker/library/node:22' });
const deploy = new Workflow(set, 'deploy', {
  on: [Trigger.manual({ inputs: {
    env: { choices: ['staging', 'prod'] },
    dryRun: { type: 'boolean', default: true },
  } })],
});
deploy.job('migrate', {
  steps: (inputs) => ['echo migrate --env ' + inputs.env + ' --dry-run ' + inputs.dryRun],
});
export default set;
`);
    const executor = new FakeExecutor();
    const prompts: string[] = [];
    const { deps } = harness(root, executor, {
      promptLine: async (question) => {
        prompts.push(question);
        return 'prod';
      },
    });

    const result = await localRun(deps, { workflow: 'deploy', input: ['dryRun=false'] });

    expect(result.status).toBe('SUCCEEDED');
    expect(prompts).toHaveLength(1);
    expect(prompts[0]).toContain('env');
    const state = readLocalRunFile(result.stateFile);
    expect(state.run.inputs).toEqual({ env: 'prod', dryRun: false });
    const model = JSON.parse(
      fs.readFileSync(path.join(root, '.millwright', 'runs', 'local-1', 'in', 'model.json'), 'utf8'),
    );
    const step = model.workflows[0].jobs[0].steps[0];
    expect(step.run).toBe('echo migrate --env prod --dry-run false');
  });

  it('non-interactive runs fail plainly on a required input with no default', async () => {
    const root = fixtureRepo(`
import { Trigger, Workflow, WorkflowSet } from '@copperbox/millwright-workflows';
const set = new WorkflowSet({ image: 'public.ecr.aws/docker/library/node:22' });
const deploy = new Workflow(set, 'deploy', {
  on: [Trigger.manual({ inputs: { env: { choices: ['staging', 'prod'] } } })],
});
deploy.job('migrate', { steps: ['echo hi'] });
export default set;
`);
    const { deps } = harness(root, new FakeExecutor(), { promptLine: undefined });

    await expect(localRun(deps, { workflow: 'deploy' })).rejects.toThrow(
      /input "env" has no default/,
    );
  });

  it('names the known workflows when asked for one that does not exist', async () => {
    const root = fixtureRepo(CI_DEFINITION);
    const { deps } = harness(root, new FakeExecutor());

    await expect(localRun(deps, { workflow: 'nope' })).rejects.toThrow(/has: ci/);
  });

  it('writes a state file runs show can read', async () => {
    const root = fixtureRepo(CI_DEFINITION);
    const { deps } = harness(root, new FakeExecutor({ build: { artifacts: ['dist'] } }));
    await localRun(deps, { workflow: 'ci' });

    const lines: string[] = [];
    const shown = runsShowLocal({ output: (line) => lines.push(line), cwd: root }, 'local-1');

    expect(shown.run.status).toBe('SUCCEEDED');
    expect(lines[0]).toMatch(/^local\/millwright-run-.+\/ci local-1  SUCCEEDED$/);
    expect(lines.some((line) => line.includes('local run — never reported to GitHub'))).toBe(true);
    expect(lines.some((line) => /^ {2}build {2}SUCCEEDED/.test(line))).toBe(true);
    expect(lines.some((line) => /^ {4}1\. step 1 {2}SUCCEEDED/.test(line))).toBe(true);
  });

  it('rejects an unknown local run id in runs show', () => {
    const root = fixtureRepo(CI_DEFINITION);
    expect(() => runsShowLocal({ output: () => {}, cwd: root }, 'local-9')).toThrow(CommandError);
  });
});
