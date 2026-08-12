import { RunCoordinates } from './keys';
import { RunModelCache, RunModelJob, RunModelStep } from './run-model';
import { SHIM_PREFIX, SOURCE_OBJECT_NAME, cachePrefix, runInputPrefix, runOutputPrefix } from './s3-layout';
import { secretParameterName } from './ssm-paths';

/**
 * The shared buildspec renderer (spec §7.4, §11.2) — the single place the
 * per-job buildspec is authored, used by the synth step, the decider's
 * dispatch, and the local runner. Synth contributes ONLY the step list and
 * declared env names; everything wrapping them — prelude, shim delivery,
 * cache and artifact phases, secret resolution — is rendered here, by
 * control-plane code. Repo code never authors the buildspec that wraps it.
 *
 * The rendered document is host-neutral: the same output drives cloud
 * CodeBuild and the local `docker run` host. Host differences arrive via
 * environment, never via re-rendering —
 *
 * - the shim directory: CodeBuild materializes the S3 secondary source at
 *   `$CODEBUILD_SRC_DIR_shim`; the local runner bind-mounts the shim and
 *   sets {@link SHIM_DIR_ENV}, which takes precedence.
 * - data-plane roots: {@link OUT_URI_ENV} / {@link CACHE_URI_ENV} are
 *   `s3://` URIs in the cloud ({@link dataPlaneEnvironment}) and plain
 *   filesystem paths locally; the shim speaks both.
 *
 * All data-plane work (source unpack, artifact fetch/upload, cache
 * restore/save, step events) goes through the shim binary — the job image's
 * contract stays "Linux + POSIX shell, nothing more" (§11.1), with no aws
 * CLI, tar or git required. Cache policy lives in the shim too: `restore`
 * records an exact-hit marker that makes `save` a no-op, and `step` runs
 * `--skip-if` first, reporting SKIPPED (reason: skip_if) on exit 0 while
 * the job continues.
 *
 * The output is serialized as JSON — every JSON document is valid YAML, so
 * CodeBuild accepts it verbatim, and JSON.stringify makes YAML injection
 * from repo-authored strings structurally impossible.
 */

/** Secondary-source identifier the shim is delivered under. */
export const SHIM_SOURCE_IDENTIFIER = 'shim';

/** The shim binary's file name inside its delivery prefix. */
export const SHIM_BINARY_NAME = 'millwright-shim';

/** Local-host override for the shim directory (bind-mount target). */
export const SHIM_DIR_ENV = 'MILLWRIGHT_SHIM_DIR';

/** The run's `out/` root — `s3://` URI in the cloud, a path locally. */
export const OUT_URI_ENV = 'MILLWRIGHT_OUT_URI';

/** The repo's `cache/` root — `s3://` URI in the cloud, a path locally. */
export const CACHE_URI_ENV = 'MILLWRIGHT_CACHE_URI';

/**
 * Env-name prefixes the control plane owns. Repo-declared env vars and
 * secret names under these prefixes are dropped at render/dispatch: a
 * definition must not be able to overwrite job identity (`MILLWRIGHT_*`),
 * agent state (`CODEBUILD_*`) or the build role's credentials (`AWS_*`).
 */
export const RESERVED_ENV_PREFIXES = ['MILLWRIGHT_', 'CODEBUILD_', 'AWS_'] as const;

export function isReservedEnvName(name: string): boolean {
  const upper = name.toUpperCase();
  return RESERVED_ENV_PREFIXES.some((prefix) => upper.startsWith(prefix));
}

/** POSIX single-quoting; makes any string one safe shell word. */
export function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'\\''`)}'`;
}

/**
 * The shim invocation fragment: the local runner's bind-mount env var wins,
 * CodeBuild's secondary-source dir is the cloud default. Inlined into every
 * command so no cross-command shell state is ever assumed. Invoked through
 * `sh` because S3 materialization strips execute bits — the delivered
 * `millwright-shim` entry is a POSIX-sh dispatcher that execs the real
 * per-arch binary beside it.
 */
const SHIM = `sh "\${${SHIM_DIR_ENV}:-$CODEBUILD_SRC_DIR_${SHIM_SOURCE_IDENTIFIER}}/${SHIM_BINARY_NAME}"`;

/**
 * Post-build phases run even after a failed build phase; artifact upload and
 * cache save only make sense for a succeeding job. The local runner sets the
 * same variable for parity.
 */
const ON_SUCCESS_GUARD = '[ "${CODEBUILD_BUILD_SUCCEEDING:-1}" = "1" ]';

/**
 * Privileged prelude (§11.2): auto-start dockerd only when no docker socket
 * is already live. Locally the host socket is mounted, so the liveness guard
 * makes this a no-op; in the cloud the image carries dockerd by contract.
 */
const DOCKERD_PRELUDE =
  'if ! docker info >/dev/null 2>&1; then ' +
  'dockerd >/tmp/millwright-dockerd.log 2>&1 & ' +
  'i=0; until docker info >/dev/null 2>&1; do i=$((i+1)); ' +
  'if [ "$i" -ge 60 ]; then echo "millwright: dockerd did not become ready" >&2; exit 1; fi; ' +
  'sleep 1; done; fi';

export interface BuildspecContext {
  /** Deployment name — roots the SSM paths `parameter` secrets resolve to. */
  readonly deploymentName: string;
  /** The run's repo — the default secret scope. */
  readonly repo: string;
}

export interface RenderedBuildspec {
  readonly version: '0.2';
  readonly env: {
    /** The image contract is POSIX shell, nothing more (§11.1). */
    readonly shell: string;
    readonly 'parameter-store'?: Readonly<Record<string, string>>;
    readonly 'secrets-manager'?: Readonly<Record<string, string>>;
  };
  readonly phases: {
    readonly install?: { readonly commands: readonly string[] };
    readonly pre_build: { readonly commands: readonly string[] };
    readonly build: { readonly commands: readonly string[] };
    readonly post_build?: { readonly commands: readonly string[] };
  };
}

function stepCommand(step: RunModelStep, index: number): string {
  const flags = [
    `--index ${index}`,
    ...(step.name ? [`--name ${shellQuote(step.name)}`] : []),
    ...(step.skipIf ? [`--skip-if ${shellQuote(step.skipIf)}`] : []),
  ];
  return `${SHIM} step ${flags.join(' ')} -- ${shellQuote(step.run)}`;
}

function cacheKeyFlags(cache: RunModelCache, includeRestoreKeys: boolean): string {
  return [
    `--key ${shellQuote(cache.key)}`,
    ...(includeRestoreKeys
      ? (cache.restoreKeys ?? []).map((key) => `--restore-key ${shellQuote(key)}`)
      : []),
    ...cache.paths.map((path) => `--path ${shellQuote(path)}`),
  ].join(' ');
}

/**
 * Secret env blocks (§11.2): CodeBuild-native `parameter-store` /
 * `secrets-manager`, resolved by the agent before any phase runs, with
 * exact-match log masking. A reference the definition declared but the job
 * role was never granted fails closed on the missing grant — rendering here
 * is preamble integrity, not parameter security. Reserved env names are
 * dropped, never honored.
 */
function secretBlocks(
  job: RunModelJob,
  ctx: BuildspecContext,
): Pick<RenderedBuildspec['env'], 'parameter-store' | 'secrets-manager'> {
  const parameterStore: Record<string, string> = {};
  const secretsManager: Record<string, string> = {};
  for (const [envName, ref] of Object.entries(job.secrets ?? {})) {
    if (isReservedEnvName(envName)) {
      continue;
    }
    if ('parameter' in ref) {
      parameterStore[envName] = secretParameterName(
        ctx.deploymentName,
        ref.scope ?? ctx.repo,
        ref.parameter,
      );
    } else {
      secretsManager[envName] = ref.secretsManager;
    }
  }
  return {
    ...(Object.keys(parameterStore).length > 0 ? { 'parameter-store': parameterStore } : {}),
    ...(Object.keys(secretsManager).length > 0 ? { 'secrets-manager': secretsManager } : {}),
  };
}

/**
 * One job's buildspec, structured (spec §11.2's shape end to end): privileged
 * prelude, source unpack, consumed-artifact fetch, cache restore, shim-
 * wrapped steps, artifact upload and cache save (both success-guarded; save
 * additionally no-ops on the restore's exact-hit marker).
 */
export function buildspecForJob(job: RunModelJob, ctx: BuildspecContext): RenderedBuildspec {
  const preBuild = [
    // The agent (or local runner) already delivered in/ as the primary
    // source; the shim unpacks the packaged repo into the workdir. Jobs
    // never clone (§9.3).
    `${SHIM} source unpack --archive ${SOURCE_OBJECT_NAME}`,
    ...(job.consumes ?? []).map(
      (consumed) =>
        `${SHIM} artifact fetch --job ${shellQuote(consumed.job)} ` +
        `--name ${shellQuote(consumed.artifact)}`,
    ),
    ...(job.cache ? [`${SHIM} cache restore ${cacheKeyFlags(job.cache, true)}`] : []),
  ];

  const postBuild = [
    ...(job.produces ?? []).map(
      (artifact) =>
        `if ${ON_SUCCESS_GUARD}; then ${SHIM} artifact upload ` +
        `--name ${shellQuote(artifact.name)} ` +
        `${artifact.paths.map((path) => `--path ${shellQuote(path)}`).join(' ')}; fi`,
    ),
    ...(job.cache
      ? [`if ${ON_SUCCESS_GUARD}; then ${SHIM} cache save ${cacheKeyFlags(job.cache, false)}; fi`]
      : []),
  ];

  return {
    version: '0.2',
    env: { shell: '/bin/sh', ...secretBlocks(job, ctx) },
    phases: {
      ...(job.privileged === true ? { install: { commands: [DOCKERD_PRELUDE] } } : {}),
      pre_build: { commands: preBuild },
      build: { commands: job.steps.map(stepCommand) },
      ...(postBuild.length > 0 ? { post_build: { commands: postBuild } } : {}),
    },
  };
}

/** The buildspec as CodeBuild consumes it: JSON, which is valid YAML. */
export function renderJobBuildspec(job: RunModelJob, ctx: BuildspecContext): string {
  return JSON.stringify(buildspecForJob(job, ctx), null, 2);
}

function s3Uri(bucketName: string, prefix: string): string {
  return `s3://${bucketName}/${prefix.replace(/\/$/, '')}`;
}

/**
 * The cloud values of the data-plane env vars the rendered commands rely on,
 * set per build via `environmentVariablesOverride` at dispatch. The local
 * runner sets the same names to filesystem paths.
 */
export function dataPlaneEnvironment(
  run: RunCoordinates,
  bucketName: string,
): Readonly<Record<string, string>> {
  return {
    [OUT_URI_ENV]: s3Uri(bucketName, runOutputPrefix(run)),
    [CACHE_URI_ENV]: s3Uri(bucketName, cachePrefix(run.repo)),
  };
}

/** StartBuild `sourceLocationOverride`: the run's `in/` prefix (S3 form). */
export function runInputSourceLocation(run: RunCoordinates, bucketName: string): string {
  return `${bucketName}/${runInputPrefix(run)}`;
}

/** StartBuild secondary-source location delivering the shim (S3 form). */
export function shimSourceLocation(bucketName: string): string {
  return `${bucketName}/${SHIM_PREFIX}`;
}
