/**
 * The synth job body (spec §7.2) — everything that happens inside the
 * CodeBuild synth build, as one testable function. The buildspec the synth
 * Lambda renders is a single `node synth-job.bundle.js`; this code is the
 * control plane's own tooling, delivered as an S3 assets source (C13), never
 * resolved from the watched repo.
 *
 * Trust boundary: from the dependency install onward this process executes
 * repo-controlled code. Everything it can reach is exactly the synth job
 * role's grants — deploy key, host-key pins, repo config, `PutObject` on the
 * run's `in/` prefix. Nothing here is trusted by the control plane until the
 * post-synth step re-validates `model.json`.
 */

import * as fs from 'fs';
import * as path from 'path';
import { SynthCommandOptions } from '../synth-command';
import {
  MODEL_OBJECT,
  SOURCE_OBJECT,
  SYNTH_ERROR_OBJECT,
  SynthJobConfig,
  configFromEnv,
  prNumberFromRef,
  shortRefName,
} from './config';
import { installPlan } from './install';

export interface RecordedCommand {
  readonly file: string;
  readonly args: readonly string[];
  readonly options: { readonly cwd?: string; readonly env?: Record<string, string> };
}

export interface SynthJobDeps {
  readonly env: Readonly<Record<string, string | undefined>>;
  /** Scratch directory for the checkout, key material and outputs. */
  readonly workdir: string;
  /** Spawn with inherited stdio; rejects on non-zero exit. */
  readonly run: (
    file: string,
    args: readonly string[],
    options: { cwd?: string; env?: Record<string, string> },
  ) => Promise<void>;
  /** Bound to the destination bucket; key is relative to the bucket root. */
  readonly putObject: (key: string, body: Buffer | string) => Promise<void>;
  /** `runSynthCommand`, injected for tests. */
  readonly synth: (options: SynthCommandOptions) => number;
  readonly stderr: (text: string) => void;
}

class SynthStepError extends Error {}

/** Exit code for the build phase: 0 on success, 1 on any failure. */
export async function runSynthJob(deps: SynthJobDeps): Promise<number> {
  let config: SynthJobConfig;
  try {
    config = configFromEnv(deps.env);
  } catch (err) {
    // Without MILLWRIGHT_DEST_* there is nowhere to write the error object.
    deps.stderr(`millwright synth job: ${(err as Error).message}\n`);
    return 1;
  }

  try {
    const sourceDir = await checkout(deps, config);
    const archivePath = await packageSource(deps, sourceDir);
    await installDependencies(deps, sourceDir);
    const modelPath = synthesizeModel(deps, config, sourceDir);
    await deps.putObject(`${config.destPrefix}${MODEL_OBJECT}`, fs.readFileSync(modelPath));
    await deps.putObject(`${config.destPrefix}${SOURCE_OBJECT}`, fs.readFileSync(archivePath));
    return 0;
  } catch (err) {
    const message = (err as Error).message ?? String(err);
    deps.stderr(`millwright synth job failed: ${message}\n`);
    await writeErrorObject(deps, config, message);
    return 1;
  }
}

/**
 * Clone at the triggering commit with the repo's deploy key, host keys
 * verified against the same SSM pins as the poller. For PR runs, one explicit
 * extra fetch of `+refs/pull/N/head` — the PR head lives in the base repo's
 * namespace, readable by the deploy key; no fork remote, no fork credential,
 * ever (spec §13.1a).
 */
async function checkout(deps: SynthJobDeps, config: SynthJobConfig): Promise<string> {
  const keyFile = path.join(deps.workdir, 'deploy-key');
  const knownHosts = path.join(deps.workdir, 'known_hosts');
  fs.writeFileSync(keyFile, config.deployKey, { mode: 0o600 });
  fs.writeFileSync(knownHosts, config.hostKeys);

  const sourceDir = path.join(deps.workdir, 'src');
  fs.mkdirSync(sourceDir, { recursive: true });
  const gitEnv = {
    GIT_SSH_COMMAND:
      `ssh -i ${keyFile} -o UserKnownHostsFile=${knownHosts} ` +
      '-o StrictHostKeyChecking=yes -o IdentitiesOnly=yes',
  };
  const git = (args: readonly string[]) =>
    deps.run('git', args, { cwd: sourceDir, env: gitEnv });

  await git(['init', '--quiet', '.']);
  await git(['remote', 'add', 'origin', `git@github.com:${config.repo}.git`]);
  const prNumber = prNumberFromRef(config.ref);
  if (prNumber !== undefined) {
    await git([
      'fetch',
      '--quiet',
      '--no-tags',
      '--depth',
      '1',
      'origin',
      `+refs/pull/${prNumber}/head`,
    ]);
  }
  await git(['fetch', '--quiet', '--no-tags', '--depth', '1', 'origin', config.sha]);
  await git([
    '-c',
    'advice.detachedHead=false',
    'checkout',
    '--quiet',
    '--detach',
    config.sha,
  ]);
  return sourceDir;
}

/**
 * `source.tar.gz` is packaged from the pristine checkout, BEFORE the
 * dependency install — jobs consume the repo's tree at the commit, never the
 * synth job's node_modules. `.git` is excluded: jobs never clone (§9.3).
 */
async function packageSource(deps: SynthJobDeps, sourceDir: string): Promise<string> {
  const archivePath = path.join(deps.workdir, SOURCE_OBJECT);
  await deps.run('tar', ['-czf', archivePath, '--exclude=.git', '-C', sourceDir, '.'], {});
  return archivePath;
}

async function installDependencies(deps: SynthJobDeps, sourceDir: string): Promise<void> {
  const plan = installPlan((file) => fs.existsSync(path.join(sourceDir, file)));
  if (!plan) {
    deps.stderr('millwright synth job: no package.json at the repo root; skipping install\n');
    return;
  }
  if (plan.warning) {
    deps.stderr(`millwright synth job: warning: ${plan.warning}\n`);
  }
  await deps.run(plan.file, plan.args, { cwd: sourceDir });
}

function synthesizeModel(
  deps: SynthJobDeps,
  config: SynthJobConfig,
  sourceDir: string,
): string {
  const modelPath = path.join(deps.workdir, MODEL_OBJECT);
  const exitCode = deps.synth({
    cwd: sourceDir,
    repo: config.repo,
    commit: config.sha,
    ref: shortRefName(config.ref),
    out: modelPath,
    schemaCeiling: config.schemaCeiling,
    ...(config.pollCadenceMinutes !== undefined
      ? { pollCadence: config.pollCadenceMinutes }
      : {}),
    ...(config.secretsAllowedRefs !== undefined
      ? { secretsAllowedRefs: config.secretsAllowedRefs }
      : {}),
    stderr: deps.stderr,
  });
  if (exitCode !== 0) {
    throw new SynthStepError(
      'synth failed — the workflow definition did not produce a valid run model ' +
        '(diagnostics above)',
    );
  }
  return modelPath;
}

/**
 * Best-effort: land the failure next to where the model would have gone so
 * the completer can surface a real message in the synth check. A failure
 * here must not mask the original error.
 */
async function writeErrorObject(
  deps: SynthJobDeps,
  config: SynthJobConfig,
  message: string,
): Promise<void> {
  try {
    await deps.putObject(
      `${config.destPrefix}${SYNTH_ERROR_OBJECT}`,
      JSON.stringify({ message }),
    );
  } catch (err) {
    deps.stderr(`millwright synth job: could not write ${SYNTH_ERROR_OBJECT}: ${String(err)}\n`);
  }
}
