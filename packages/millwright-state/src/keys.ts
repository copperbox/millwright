/**
 * State-table key shapes (spec §9.1). One single-table design; every accessor
 * here is the only place its key shape is spelled out.
 *
 * Delimiter rules: `#` joins key segments. Repo names (`owner/name`), workflow
 * and job names, shas and event kinds can never contain `#`, so keys parse
 * unambiguously. Refs and concurrency-group keys MAY contain `#`; the shapes
 * that embed them either put them last (parsed by prefix-slice) or surround
 * them with `#`-free segments (parsed from both ends).
 */

/** DynamoDB attribute names for the table's composite primary key. */
export const PARTITION_KEY_ATTRIBUTE = 'pk';
export const SORT_KEY_ATTRIBUTE = 'sk';

/** Sort-key value for single-item partitions (`EVENT#`, `BUILD#`, `GROUP#`). */
export const SINGLETON_SORT_KEY = '-';

/** A state-table composite primary key. */
export interface ItemKey {
  readonly pk: string;
  readonly sk: string;
}

/** Identifies one run of one workflow in one repo. */
export interface RunCoordinates {
  /** Watched repo as `owner/name`. */
  readonly repo: string;
  readonly workflow: string;
  /** Workflow-scoped run number, from the atomic counter (1-based). */
  readonly runNumber: number;
}

/** Event kinds carried on the bus (spec C3). */
export const TRIGGER_KINDS = [
  'push',
  'branch',
  'tag',
  'pr',
  'cron',
  'dispatch',
  'bootstrap',
  'rerun',
] as const;
export type TriggerKind = (typeof TRIGGER_KINDS)[number];

/** The content-derived identity of a bus event, used for launcher dedupe. */
export interface EventIdentity {
  readonly repo: string;
  readonly ref: string;
  readonly sha: string;
  readonly kind: TriggerKind;
  /**
   * Extra identity segment for kinds whose content identity is finer than
   * (repo, ref, sha): cron fires carry their UTC minute here, so double-fires
   * of one minute cancel exactly while distinct minutes on an unchanged head
   * still run. Absent for every other kind.
   */
  readonly qualifier?: string;
}

export class KeyFormatError extends Error {}

/**
 * Width of the zero-padded run number in `RUN#` sort keys. 12 digits is
 * effectively unbounded (a per-minute trigger takes ~1.9M years to exhaust it)
 * while staying far inside Number.MAX_SAFE_INTEGER for the inversion.
 */
export const RUN_NUMBER_WIDTH = 12;
export const MAX_RUN_NUMBER = 10 ** RUN_NUMBER_WIDTH - 1;

/** Width of the zero-padded step index in step sort keys. */
export const STEP_INDEX_WIDTH = 4;
export const MAX_STEP_INDEX = 10 ** STEP_INDEX_WIDTH - 1;

function assertSegment(label: string, value: string): void {
  if (!value) {
    throw new KeyFormatError(`${label} must not be empty`);
  }
  if (value.includes('#')) {
    throw new KeyFormatError(`${label} must not contain "#", got "${value}"`);
  }
}

function assertNonEmpty(label: string, value: string): void {
  if (!value) {
    throw new KeyFormatError(`${label} must not be empty`);
  }
}

function assertRunNumber(runNumber: number): void {
  if (!Number.isInteger(runNumber) || runNumber < 1 || runNumber > MAX_RUN_NUMBER) {
    throw new KeyFormatError(
      `Run number must be an integer in [1, ${MAX_RUN_NUMBER}], got ${runNumber}`,
    );
  }
}

const SHA_PATTERN = /^[0-9a-f]+$/i;

function assertSha(sha: string): void {
  if (!sha || !SHA_PATTERN.test(sha)) {
    throw new KeyFormatError(`sha must be a non-empty hex string, got "${sha}"`);
  }
}

function assertKind(kind: string): asserts kind is TriggerKind {
  if (!(TRIGGER_KINDS as readonly string[]).includes(kind)) {
    throw new KeyFormatError(`Unknown event kind "${kind}"`);
  }
}

function parseFail(shape: string, key: ItemKey): never {
  throw new KeyFormatError(`Not a ${shape} key: pk="${key.pk}" sk="${key.sk}"`);
}

/**
 * The `RUN#` sort-key payload: the run number inverted against the maximum
 * and zero-padded, so ascending lexicographic sort-key order is descending
 * run-number order — a plain Query returns newest runs first.
 */
export function invertedRunNumber(runNumber: number): string {
  assertRunNumber(runNumber);
  return String(MAX_RUN_NUMBER - runNumber).padStart(RUN_NUMBER_WIDTH, '0');
}

export function parseInvertedRunNumber(inverted: string): number {
  if (!new RegExp(`^\\d{${RUN_NUMBER_WIDTH}}$`).test(inverted)) {
    throw new KeyFormatError(
      `Inverted run number must be exactly ${RUN_NUMBER_WIDTH} digits, got "${inverted}"`,
    );
  }
  const runNumber = MAX_RUN_NUMBER - Number(inverted);
  assertRunNumber(runNumber);
  return runNumber;
}

// --- Run counter: WF#<repo>#<workflow> / COUNTER --------------------------

export function runCounterKey(repo: string, workflow: string): ItemKey {
  assertSegment('repo', repo);
  assertSegment('workflow', workflow);
  return { pk: `WF#${repo}#${workflow}`, sk: 'COUNTER' };
}

export function parseRunCounterKey(key: ItemKey): { repo: string; workflow: string } {
  const parts = key.pk.split('#');
  if (parts.length !== 3 || parts[0] !== 'WF' || key.sk !== 'COUNTER') {
    parseFail('run counter', key);
  }
  return { repo: parts[1], workflow: parts[2] };
}

// --- Run: WF#<repo>#<workflow> / RUN#<inverted zero-padded number> --------

export const RUN_SORT_KEY_PREFIX = 'RUN#';

export function runKey(run: RunCoordinates): ItemKey {
  assertSegment('repo', run.repo);
  assertSegment('workflow', run.workflow);
  return {
    pk: `WF#${run.repo}#${run.workflow}`,
    sk: `${RUN_SORT_KEY_PREFIX}${invertedRunNumber(run.runNumber)}`,
  };
}

export function parseRunKey(key: ItemKey): RunCoordinates {
  const parts = key.pk.split('#');
  if (parts.length !== 3 || parts[0] !== 'WF' || !key.sk.startsWith(RUN_SORT_KEY_PREFIX)) {
    parseFail('run', key);
  }
  return {
    repo: parts[1],
    workflow: parts[2],
    runNumber: parseInvertedRunNumber(key.sk.slice(RUN_SORT_KEY_PREFIX.length)),
  };
}

// --- Run id: <repo>#<workflow>#<number> -----------------------------------

/**
 * The canonical deployment-global run identity, `<repo>#<workflow>#<number>`
 * (`octocat/app#ci#142`) — what group slots, processing records and `rerunOf`
 * store, and what the CLI renders repo-scoped as `ci#142`.
 */
export function formatRunId(run: RunCoordinates): string {
  assertSegment('repo', run.repo);
  assertSegment('workflow', run.workflow);
  assertRunNumber(run.runNumber);
  return `${run.repo}#${run.workflow}#${run.runNumber}`;
}

export function parseRunId(runId: string): RunCoordinates {
  const parts = runId.split('#');
  if (parts.length !== 3 || !parts[0] || !parts[1] || !/^\d+$/.test(parts[2])) {
    throw new KeyFormatError(`Not a run id: "${runId}"`);
  }
  const runNumber = Number(parts[2]);
  assertRunNumber(runNumber);
  return { repo: parts[0], workflow: parts[1], runNumber };
}

// --- Job: RUN#<repo>#<workflow>#<number> / JOB#<name> ---------------------

/** `RUN#<repo>#<workflow>#<number>` — the partition holding job + step rows. */
export function runPartitionKey(run: RunCoordinates): string {
  assertSegment('repo', run.repo);
  assertSegment('workflow', run.workflow);
  assertRunNumber(run.runNumber);
  return `RUN#${run.repo}#${run.workflow}#${run.runNumber}`;
}

function parseRunPartitionKey(key: ItemKey): RunCoordinates {
  const parts = key.pk.split('#');
  if (parts.length !== 4 || parts[0] !== 'RUN' || !/^\d+$/.test(parts[3])) {
    parseFail('run-scoped', key);
  }
  return { repo: parts[1], workflow: parts[2], runNumber: Number(parts[3]) };
}

export function jobKey(run: RunCoordinates, job: string): ItemKey {
  assertSegment('job', job);
  return { pk: runPartitionKey(run), sk: `JOB#${job}` };
}

export function parseJobKey(key: ItemKey): RunCoordinates & { job: string } {
  const run = parseRunPartitionKey(key);
  const parts = key.sk.split('#');
  if (parts.length !== 2 || parts[0] !== 'JOB') {
    parseFail('job', key);
  }
  return { ...run, job: parts[1] };
}

// --- Step: RUN#<repo>#<workflow>#<number> / JOB#<name>#STEP#<index> -------

export function stepKey(run: RunCoordinates, job: string, stepIndex: number): ItemKey {
  assertSegment('job', job);
  if (!Number.isInteger(stepIndex) || stepIndex < 0 || stepIndex > MAX_STEP_INDEX) {
    throw new KeyFormatError(
      `Step index must be an integer in [0, ${MAX_STEP_INDEX}], got ${stepIndex}`,
    );
  }
  const padded = String(stepIndex).padStart(STEP_INDEX_WIDTH, '0');
  return { pk: runPartitionKey(run), sk: `JOB#${job}#STEP#${padded}` };
}

/** Sort-key prefix under which a job's step rows sort, in step order. */
export function stepSortKeyPrefix(job: string): string {
  assertSegment('job', job);
  return `JOB#${job}#STEP#`;
}

export function parseStepKey(key: ItemKey): RunCoordinates & { job: string; stepIndex: number } {
  const run = parseRunPartitionKey(key);
  const parts = key.sk.split('#');
  if (
    parts.length !== 4 ||
    parts[0] !== 'JOB' ||
    parts[2] !== 'STEP' ||
    !new RegExp(`^\\d{${STEP_INDEX_WIDTH}}$`).test(parts[3])
  ) {
    parseFail('step', key);
  }
  return { ...run, job: parts[1], stepIndex: Number(parts[3]) };
}

// --- Event dedupe / processing record: EVENT#<repo>#<ref>#<sha>#<kind>[#<qualifier>] / -

export function eventDedupeKey(event: EventIdentity): ItemKey {
  assertSegment('repo', event.repo);
  assertNonEmpty('ref', event.ref);
  assertSha(event.sha);
  assertKind(event.kind);
  if (event.qualifier !== undefined) {
    assertSegment('qualifier', event.qualifier);
  }
  const qualifier = event.qualifier === undefined ? '' : `#${event.qualifier}`;
  return {
    pk: `EVENT#${event.repo}#${event.ref}#${event.sha}#${event.kind}${qualifier}`,
    sk: SINGLETON_SORT_KEY,
  };
}

/**
 * Refs may legally contain `#`, so the ref is recovered as everything between
 * the repo (which cannot contain `#`) and the trailing sha + kind (+ optional
 * qualifier) segments — the kind is found from the end, disambiguated by the
 * segment before it having to be a sha.
 */
export function parseEventDedupeKey(key: ItemKey): EventIdentity {
  const parts = key.pk.split('#');
  if (parts.length < 5 || parts[0] !== 'EVENT' || key.sk !== SINGLETON_SORT_KEY) {
    parseFail('event dedupe', key);
  }
  const last = parts[parts.length - 1];
  const qualified = !(TRIGGER_KINDS as readonly string[]).includes(last);
  const qualifier = qualified ? last : undefined;
  const kind = qualified ? parts[parts.length - 2] : last;
  const sha = parts[parts.length - (qualified ? 3 : 2)];
  assertKind(kind);
  assertSha(sha);
  const ref = parts.slice(2, qualified ? -3 : -2).join('#');
  assertNonEmpty('ref', ref);
  return { repo: parts[1], ref, sha, kind, qualifier };
}

// --- Build mapping: BUILD#<build-id> / - ----------------------------------

const BUILD_PK_PREFIX = 'BUILD#';

export function buildMappingKey(buildId: string): ItemKey {
  assertNonEmpty('build id', buildId);
  return { pk: `${BUILD_PK_PREFIX}${buildId}`, sk: SINGLETON_SORT_KEY };
}

export function parseBuildMappingKey(key: ItemKey): { buildId: string } {
  if (!key.pk.startsWith(BUILD_PK_PREFIX) || key.sk !== SINGLETON_SORT_KEY) {
    parseFail('build mapping', key);
  }
  const buildId = key.pk.slice(BUILD_PK_PREFIX.length);
  assertNonEmpty('build id', buildId);
  return { buildId };
}

// --- Concurrency group: GROUP#<key> / - -----------------------------------

const GROUP_PK_PREFIX = 'GROUP#';

export function concurrencyGroupKey(group: string): ItemKey {
  assertNonEmpty('group key', group);
  return { pk: `${GROUP_PK_PREFIX}${group}`, sk: SINGLETON_SORT_KEY };
}

export function parseConcurrencyGroupKey(key: ItemKey): { group: string } {
  if (!key.pk.startsWith(GROUP_PK_PREFIX) || key.sk !== SINGLETON_SORT_KEY) {
    parseFail('concurrency group', key);
  }
  const group = key.pk.slice(GROUP_PK_PREFIX.length);
  assertNonEmpty('group key', group);
  return { group };
}

// --- Registry: REG#<repo> / REF#<ref> (TTL-exempt) ------------------------

export const REGISTRY_PARTITION_PREFIX = 'REG#';
const REGISTRY_SK_PREFIX = 'REF#';

export function registryKey(repo: string, ref: string): ItemKey {
  assertSegment('repo', repo);
  assertNonEmpty('ref', ref);
  return { pk: `${REGISTRY_PARTITION_PREFIX}${repo}`, sk: `${REGISTRY_SK_PREFIX}${ref}` };
}

export function parseRegistryKey(key: ItemKey): { repo: string; ref: string } {
  if (!key.pk.startsWith(REGISTRY_PARTITION_PREFIX) || !key.sk.startsWith(REGISTRY_SK_PREFIX)) {
    parseFail('registry', key);
  }
  const repo = key.pk.slice(REGISTRY_PARTITION_PREFIX.length);
  const ref = key.sk.slice(REGISTRY_SK_PREFIX.length);
  assertSegment('repo', repo);
  assertNonEmpty('ref', ref);
  return { repo, ref };
}

// --- Check state: CHECK#<repo>#<sha> / CTX#<context> ----------------------

const CHECK_SK_PREFIX = 'CTX#';

export function checkStateKey(repo: string, sha: string, context: string): ItemKey {
  assertSegment('repo', repo);
  assertSha(sha);
  assertNonEmpty('context', context);
  return { pk: `CHECK#${repo}#${sha}`, sk: `${CHECK_SK_PREFIX}${context}` };
}

export function parseCheckStateKey(key: ItemKey): { repo: string; sha: string; context: string } {
  const parts = key.pk.split('#');
  if (parts.length !== 3 || parts[0] !== 'CHECK' || !key.sk.startsWith(CHECK_SK_PREFIX)) {
    parseFail('check state', key);
  }
  assertSha(parts[2]);
  const context = key.sk.slice(CHECK_SK_PREFIX.length);
  assertNonEmpty('context', context);
  return { repo: parts[1], sha: parts[2], context };
}
