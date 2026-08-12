import { KeyFormatError, RunCoordinates } from './keys';

/**
 * Object layout of the artifact/cache bucket (spec §9.3):
 *
 *     runs/<repo>/<workflow>/<number>/
 *         in/                          control-plane inputs — synth writes, jobs read
 *             model.json
 *             source.tar.gz
 *         out/<job>/<artifact-name>/…  each job writes ONLY its own out/<job>/ subtree
 *     cache/<repo>/<key>               keyed dependency-cache objects
 *
 * Run numbers appear plain (not inverted) — S3 ordering is irrelevant here
 * and plain numbers keep prefixes greppable.
 */

export const RUNS_PREFIX = 'runs/';
export const CACHE_PREFIX = 'cache/';

export const MODEL_OBJECT_NAME = 'model.json';
export const SOURCE_OBJECT_NAME = 'source.tar.gz';

function assertPart(label: string, value: string): void {
  if (!value || value.includes('/') || value.includes('..')) {
    throw new KeyFormatError(`${label} must be non-empty and free of "/" and "..", got "${value}"`);
  }
}

function assertRepo(repo: string): void {
  if (!repo || !/^[^/]+\/[^/]+$/.test(repo) || repo.includes('..')) {
    throw new KeyFormatError(`repo must be "owner/name", got "${repo}"`);
  }
}

/** `runs/<repo>/<workflow>/<number>/` — everything belonging to one run. */
export function runPrefix(run: RunCoordinates): string {
  assertRepo(run.repo);
  assertPart('workflow', run.workflow);
  if (!Number.isInteger(run.runNumber) || run.runNumber < 1) {
    throw new KeyFormatError(`Run number must be a positive integer, got ${run.runNumber}`);
  }
  return `${RUNS_PREFIX}${run.repo}/${run.workflow}/${run.runNumber}/`;
}

/** `…/in/` — control-plane inputs; synth role writes, job roles read-only. */
export function runInputPrefix(run: RunCoordinates): string {
  return `${runPrefix(run)}in/`;
}

/** `…/in/model.json` — the validated run model. */
export function modelObjectKey(run: RunCoordinates): string {
  return `${runInputPrefix(run)}${MODEL_OBJECT_NAME}`;
}

/** `…/in/source.tar.gz` — the packaged source; jobs never clone. */
export function sourceObjectKey(run: RunCoordinates): string {
  return `${runInputPrefix(run)}${SOURCE_OBJECT_NAME}`;
}

/** `…/out/` — all job outputs; the rerun prefix-copy root. */
export function runOutputPrefix(run: RunCoordinates): string {
  return `${runPrefix(run)}out/`;
}

/** `…/out/<job>/` — the ONLY subtree the job's role may write. */
export function jobOutputPrefix(run: RunCoordinates, job: string): string {
  assertPart('job', job);
  return `${runOutputPrefix(run)}${job}/`;
}

/** `…/out/<job>/<artifact-name>/` — one declared artifact's objects. */
export function artifactPrefix(run: RunCoordinates, job: string, artifact: string): string {
  assertPart('artifact name', artifact);
  return `${jobOutputPrefix(run, job)}${artifact}/`;
}

/** `cache/<repo>/` — the repo's keyed dependency-cache subtree (repo-scoped trust). */
export function cachePrefix(repo: string): string {
  assertRepo(repo);
  return `${CACHE_PREFIX}${repo}/`;
}

/** `cache/<repo>/<key>` — one keyed cache object. */
export function cacheObjectKey(repo: string, cacheKey: string): string {
  if (!cacheKey || cacheKey.includes('..')) {
    throw new KeyFormatError(`cache key must be non-empty and free of "..", got "${cacheKey}"`);
  }
  return `${cachePrefix(repo)}${cacheKey}`;
}
