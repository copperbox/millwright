import {
  BRANCH_REF_PREFIX,
  ConcurrencyGroupItem,
  EventIdentity,
  JobItem,
  RERUNNABLE_JOB_STATUSES,
  RegistryItem,
  RunCoordinates,
  RunItem,
  TERMINAL_RUN_STATUSES,
  ValidBusEvent,
  desiredSynthCancelled,
  desiredSynthStarted,
  formatRunId,
  jobOutputPrefix,
  parseRunId,
  runInputPrefix,
  runKey,
  synthCheckContext,
  validateBusEvent,
  withMetadataTtl,
} from '@copperbox/millwright-state';
import { DesiredCheckWrite } from '../shared/checks';
import { ExecutionStarter } from '../shared/executions';
import { evaluateGroupKey, matchWorkflows, workflowConcurrency } from './match';

/**
 * The launcher's pinned order (spec §7.1, council ruling B1 — validation
 * strictly precedes the dedupe write):
 *
 *   1. validate source and shape (static, no I/O)
 *   2. dedupe — conditional put of the content-keyed processing record
 *   3. match via the per-ref registry, default-branch fallback,
 *      bootstrap-on-miss
 *   4. increment the per-workflow run counter
 *   5. write the run record (PENDING)
 *   6. gate concurrency — proceed, or QUEUED in place
 *   7. StartExecution on the run executor
 *
 * Crash-and-redeliver at ANY point converges: the processing record carries
 * each created run's id, run creation is transactional with recording it,
 * group claims are conditional, and executions are started under
 * deterministic names. Replay-after-bootstrap needs no side channel — the
 * launcher throws `RetryLater`, the SQS delivery returns to the queue, and a
 * later redelivery finds the registry entry the bootstrap synth wrote.
 */

/** Raised for states that resolve themselves — the delivery must be retried. */
export class RetryLater extends Error {}

export interface LauncherStore {
  /**
   * Step 2: conditional put of the processing record (30-min TTL, empty
   * `runIds`). Never overwrites: an existing record is returned as-is with
   * `created: false`.
   */
  claimEvent(
    identity: EventIdentity,
    nowMs: number,
  ): Promise<{ created: boolean; runIds: Readonly<Record<string, string>> }>;
  getRegistryEntry(repo: string, ref: string): Promise<RegistryItem | undefined>;
  /** Step 4: atomic counter increment — numbers are never reused. */
  nextRunNumber(repo: string, workflow: string, nowMs: number): Promise<number>;
  /**
   * Step 5, transactional: put the PENDING run record AND record its id on
   * the processing record under its workflow name. Returns false when a
   * concurrent delivery recorded a run for this workflow first (the caller
   * re-reads and adopts that run; this delivery's number is abandoned).
   */
  createRun(run: RunItem, identity: EventIdentity, nowMs: number): Promise<boolean>;
  /**
   * The §13.2 ownership upsert onto a check item — used for the run's
   * `<workflow> / synth` check at run start. False when a newer run already
   * owns the context.
   */
  putDesiredCheck(write: DesiredCheckWrite, nowMs: number): Promise<boolean>;
  getRun(coords: RunCoordinates): Promise<RunItem | undefined>;
  /** The source run's job rows — what a rerun's reuse set is computed from. */
  listJobs(coords: RunCoordinates): Promise<readonly JobItem[]>;
  getGroup(group: string): Promise<ConcurrencyGroupItem | undefined>;
  /** Claim the group's running slot; succeeds when free or already ours. */
  claimRunningSlot(group: string, runId: string, nowMs: number): Promise<boolean>;
  /**
   * Claim the group's pending slot-of-one and mark the run QUEUED, in one
   * transaction, conditioned on the group state the caller just read.
   */
  claimPendingSlot(
    group: string,
    runId: string,
    opts: {
      /** Condition: the running slot still holds this id. */
      readonly expectedRunning: string;
      /** Condition: current pending occupant (absent = slot must be empty). */
      readonly expectedPending?: string;
      /** My run to flip PENDING → QUEUED. */
      readonly markQueued: RunCoordinates;
      /** Replaced pending run to cancel (`reason: superseded`). */
      readonly cancelReplaced?: RunCoordinates;
      /** supersede policy: running run to flag `cancelRequested`. */
      readonly requestCancelOf?: RunCoordinates;
    },
    nowMs: number,
  ): Promise<boolean>;
}

export type { ExecutionStarter };

export interface ArtifactCopier {
  /**
   * Copy every object under `fromPrefix` to the same relative key under
   * `toPrefix` (the §7.7 rerun prefix-copy). Overwrite-idempotent. Returns
   * the number of objects copied.
   */
  copyPrefix(fromPrefix: string, toPrefix: string): Promise<number>;
}

export interface LauncherDeps {
  readonly store: LauncherStore;
  readonly starter: ExecutionStarter;
  readonly copier: ArtifactCopier;
  readonly metadataRetentionDays: number;
  readonly log: (message: string, fields?: Record<string, unknown>) => void;
}

/** The EventBridge envelope fields the launcher consumes. */
export interface BusEventEnvelope {
  readonly source: string;
  readonly 'detail-type': string;
  readonly detail: unknown;
}

export type Disposition =
  | { readonly outcome: 'rejected'; readonly reason: string }
  | { readonly outcome: 'bootstrap-started' }
  | { readonly outcome: 'no-match' }
  | {
      readonly outcome: 'runs';
      readonly started: readonly string[];
      readonly queued: readonly string[];
      readonly settled: readonly string[];
    };

const GROUP_CLAIM_ATTEMPTS = 5;

/**
 * The dedupe-identity qualifier: cron events key on the fired minute; rerun
 * events on the CLI's per-invocation nonce, so redeliveries coalesce while
 * every new command starts a fresh run.
 */
function identityQualifier(event: ValidBusEvent): string | undefined {
  switch (event.kind) {
    case 'cron':
      return event.minute;
    case 'rerun':
      return event.nonce;
    default:
      return undefined;
  }
}

export async function processBusEvent(
  deps: LauncherDeps,
  envelope: BusEventEnvelope,
  nowMs: number,
): Promise<Disposition> {
  // 1. Validate — before any write, so a rejected event never poisons dedupe.
  const validation = validateBusEvent(envelope.source, envelope['detail-type'], envelope.detail);
  if (!validation.ok) {
    return { outcome: 'rejected', reason: validation.reason };
  }
  const event = validation.event;
  const identity: EventIdentity = {
    repo: event.repo,
    ref: event.ref,
    sha: event.sha,
    kind: event.kind,
    qualifier: identityQualifier(event),
  };

  // 2. Dedupe / processing record.
  const claim = await deps.store.claimEvent(identity, nowMs);
  if (!claim.created) {
    deps.log('resuming from processing record', { identity, runIds: claim.runIds });
  }

  // `repo add` prime: straight to the synth-only path, nothing to replay.
  if (event.kind === 'bootstrap') {
    await deps.starter.startSynthOnly(event.repo, event.ref, event.sha);
    return { outcome: 'bootstrap-started' };
  }

  // Reruns re-execute one named run from its stored model — no trigger
  // matching, no bootstrap, no synth.
  if (event.kind === 'rerun') {
    return processRerun(deps, event, identity, claim.runIds, nowMs);
  }

  // 3. Match via the per-ref registry, falling back to the default branch's
  //    map for never-synthed refs. There is deliberately NO cross-check
  //    against the polling table's ref map (council ruling B1).
  let registry = await deps.store.getRegistryEntry(event.repo, event.ref);
  if (!registry && event.defaultBranch) {
    registry = await deps.store.getRegistryEntry(
      event.repo,
      `${BRANCH_REF_PREFIX}${event.defaultBranch}`,
    );
  }
  if (!registry) {
    // Bootstrap on miss: start the synth-only execution (its own processing
    // record makes it once per (repo, ref, sha)), then retry this delivery —
    // a later redelivery replays the event against the registry entry the
    // bootstrap wrote, resuming from OUR processing record.
    await deps.store.claimEvent({ ...identity, kind: 'bootstrap', qualifier: undefined }, nowMs);
    await deps.starter.startSynthOnly(event.repo, event.ref, event.sha);
    throw new RetryLater(
      `no registry entry for ${event.repo}@${event.ref}; bootstrap synth started — replaying`,
    );
  }

  const { matched, malformed } = matchWorkflows(registry, event);
  for (const name of malformed) {
    deps.log('skipping workflow with uninterpretable registry entry', {
      repo: event.repo,
      ref: registry.ref,
      workflow: name,
    });
  }
  if (matched.length === 0) {
    return { outcome: 'no-match' };
  }

  const started: string[] = [];
  const queued: string[] = [];
  const settled: string[] = [];
  let runIds = claim.runIds;
  for (const workflow of matched) {
    // The group key is evaluated once, pre-creation, and stamped on the run
    // record — the decider and sweep release exactly the slot that was
    // claimed, immune to registry changes after the run exists.
    const overrides: Partial<RunItem> = workflow.concurrency
      ? { concurrencyGroup: evaluateGroupKey(workflow.concurrency.group, event, workflow.workflow) }
      : {};
    let obtained = await obtainRun(deps, event, identity, workflow.workflow, runIds, nowMs, overrides);
    if (!obtained.created) {
      // A concurrent delivery recorded a run for this workflow first — re-read
      // the processing record and adopt that run instead.
      runIds = (await deps.store.claimEvent(identity, nowMs)).runIds;
      obtained = await obtainRun(deps, event, identity, workflow.workflow, runIds, nowMs, overrides);
    }
    const run = obtained.run;
    if (!run) {
      continue;
    }
    if (run.status !== 'PENDING') {
      // A previous delivery already gated this run; nothing left to do.
      settled.push(formatRunId(run));
      continue;
    }
    await openSynthCheck(deps, run, nowMs);
    const outcome = await gate(deps, run, workflow.concurrency?.policy ?? 'queue', nowMs);
    (outcome === 'started' ? started : queued).push(formatRunId(run));
  }
  return { outcome: 'runs', started, queued, settled };
}

/**
 * Run start opens the run's `<workflow> / synth` check `in_progress` (spec
 * §13.2 lifecycle), so a broken `workflows.ts` is visible on the PR from the
 * moment the run exists — queued runs included, since their synth is only
 * waiting on the group. Post-synth completes the same item under the same
 * owner. Reruns never come here: they skip synth and would otherwise take the
 * sha's completed check back to `in_progress` for good. Best-effort — the
 * run must start whether or not the check row cooperates; post-synth's
 * completing write creates the item regardless.
 */
async function openSynthCheck(deps: LauncherDeps, run: RunItem, nowMs: number): Promise<void> {
  const label = `${run.workflow}#${run.runNumber}`;
  try {
    const written = await deps.store.putDesiredCheck(
      {
        repo: run.repo,
        sha: run.sha,
        context: synthCheckContext(run.workflow),
        ownerRun: label,
        ownerRunNumber: run.runNumber,
        desired: desiredSynthStarted(label),
      },
      nowMs,
    );
    if (!written) {
      deps.log('synth check owned by a newer run; not reopened', { runId: formatRunId(run) });
    }
  } catch (err) {
    deps.log('could not open the synth check', {
      runId: formatRunId(run),
      error: (err as Error).message,
    });
  }
}

/**
 * A pending waiter replaced by a newer arrival is CANCELLED (reason
 * superseded) without ever executing, so nothing downstream completes the
 * synth check `openSynthCheck` opened for it. Close it `cancelled` here under
 * the same owner; a newer run already owning the context drops the write.
 * Reruns never opened one and are left alone. Best-effort, like the open.
 */
async function closeSupersededSynthCheck(
  deps: LauncherDeps,
  coords: RunCoordinates,
  nowMs: number,
): Promise<void> {
  const runId = formatRunId(coords);
  try {
    const replaced = await deps.store.getRun(coords);
    if (!replaced || replaced.rerunOf) {
      return;
    }
    const label = `${replaced.workflow}#${replaced.runNumber}`;
    const written = await deps.store.putDesiredCheck(
      {
        repo: replaced.repo,
        sha: replaced.sha,
        context: synthCheckContext(replaced.workflow),
        ownerRun: label,
        ownerRunNumber: replaced.runNumber,
        desired: desiredSynthCancelled(label),
      },
      nowMs,
    );
    if (!written) {
      deps.log('superseded run’s synth check owned by a newer run; not closed', { runId });
    }
  } catch (err) {
    deps.log('could not close the superseded run’s synth check', {
      runId,
      error: (err as Error).message,
    });
  }
}

/**
 * The rerun path (spec §7.7): resolve the source run, compute the reuse set
 * for `--failed`, create the new run (fresh number, `rerunOf`) from the
 * STORED model, prefix-copy the model/source and reused outputs, then gate
 * and start exactly like any other run — the execution input's `resume`
 * flag (derived from `rerunOf`) skips synth.
 */
async function processRerun(
  deps: LauncherDeps,
  event: ValidBusEvent,
  identity: EventIdentity,
  claimedRunIds: Readonly<Record<string, string>>,
  nowMs: number,
): Promise<Disposition> {
  // validateBusEvent guarantees workflow and sourceRunNumber on rerun events.
  const sourceCoords: RunCoordinates = {
    repo: event.repo,
    workflow: event.workflow!,
    runNumber: event.sourceRunNumber!,
  };
  const sourceId = formatRunId(sourceCoords);
  const source = await deps.store.getRun(sourceCoords);
  if (!source) {
    return { outcome: 'rejected', reason: `rerun source ${sourceId} does not exist` };
  }
  if (!TERMINAL_RUN_STATUSES.includes(source.status)) {
    return {
      outcome: 'rejected',
      reason: `rerun source ${sourceId} is ${source.status}, not terminal`,
    };
  }

  let reuseJobs: readonly string[] | undefined;
  if (event.failedOnly) {
    const rows = await deps.store.listJobs(sourceCoords);
    const anyFailed = rows.some((row) => RERUNNABLE_JOB_STATUSES.includes(row.status));
    if (!anyFailed) {
      // The CLI rejects this up front; here it only survives a race.
      return { outcome: 'rejected', reason: `nothing failed in ${sourceId}; --failed rejects` };
    }
    reuseJobs = rows
      .filter((row) => row.status === 'SUCCEEDED')
      .map((row) => row.job)
      .sort();
  }

  // Reruns gate through concurrency groups like any other run (spec §7.7),
  // under the ref's CURRENT registry entry — same lookup the original used.
  const registry = await deps.store.getRegistryEntry(event.repo, source.ref);
  const concurrency = registry ? workflowConcurrency(registry, source.workflow) : undefined;
  if (concurrency === null) {
    // Fail closed like matching does: never run without declared gating.
    return {
      outcome: 'rejected',
      reason: `registry concurrency for ${source.workflow}@${source.ref} is uninterpretable`,
    };
  }
  if (!registry) {
    deps.log('no registry entry for rerun ref; gating without a group', {
      repo: event.repo,
      ref: source.ref,
    });
  }

  const overrides: Partial<RunItem> = {
    trigger: 'rerun',
    // The source run record is authoritative for what is being rerun; the
    // event's ref/sha only shaped the dedupe identity.
    ref: source.ref,
    sha: source.sha,
    rerunOf: sourceId,
    ...(reuseJobs && reuseJobs.length > 0 ? { reuseJobs } : {}),
    ...(source.inputs ? { inputs: source.inputs } : {}),
    ...(concurrency
      ? { concurrencyGroup: evaluateGroupKey(concurrency.group, event, source.workflow) }
      : {}),
  };
  let obtained = await obtainRun(
    deps,
    event,
    identity,
    source.workflow,
    claimedRunIds,
    nowMs,
    overrides,
  );
  if (!obtained.created) {
    // A concurrent delivery recorded the run first — re-read and adopt it.
    const runIds = (await deps.store.claimEvent(identity, nowMs)).runIds;
    obtained = await obtainRun(deps, event, identity, source.workflow, runIds, nowMs, overrides);
  }
  const run = obtained.run;
  if (!run) {
    return { outcome: 'runs', started: [], queued: [], settled: [] };
  }
  if (run.status !== 'PENDING') {
    return { outcome: 'runs', started: [], queued: [], settled: [formatRunId(run)] };
  }

  // Prefix-copies BEFORE gating, so a queued rerun's inputs are in place
  // whenever the group hand-off starts it. Redeliveries re-copy harmlessly.
  await deps.copier.copyPrefix(runInputPrefix(sourceCoords), runInputPrefix(run));
  for (const job of run.reuseJobs ?? []) {
    await deps.copier.copyPrefix(jobOutputPrefix(sourceCoords, job), jobOutputPrefix(run, job));
  }

  const outcome = await gate(deps, run, concurrency?.policy ?? 'queue', nowMs);
  return {
    outcome: 'runs',
    started: outcome === 'started' ? [formatRunId(run)] : [],
    queued: outcome === 'queued' ? [formatRunId(run)] : [],
    settled: [],
  };
}

async function obtainRun(
  deps: LauncherDeps,
  event: ValidBusEvent,
  identity: EventIdentity,
  workflow: string,
  runIds: Readonly<Record<string, string>>,
  nowMs: number,
  overrides: Partial<RunItem> = {},
): Promise<{ run: RunItem | undefined; created: boolean }> {
  const existing = runIds[workflow];
  if (existing) {
    const run = await deps.store.getRun(parseRunId(existing));
    if (!run) {
      deps.log('recorded run no longer exists; nothing to resume', { runId: existing });
    }
    return { run, created: true };
  }

  // 4. Counter, then 5. run record — transactional with the processing
  // record, so a duplicate delivery can never yield two runs. A crash
  // between the two leaves an unused number: numbers are dense in the happy
  // path but only guaranteed monotone and never reused.
  const runNumber = await deps.store.nextRunNumber(event.repo, workflow, nowMs);
  const coords: RunCoordinates = { repo: event.repo, workflow, runNumber };
  const createdAt = new Date(nowMs).toISOString();
  const run: RunItem = withMetadataTtl(
    {
      ...runKey(coords),
      repo: event.repo,
      workflow,
      runNumber,
      status: 'PENDING',
      trigger: event.kind,
      ref: event.ref,
      sha: event.sha,
      createdAt,
      originalStartedAt: createdAt,
      ...(event.inputs ? { inputs: event.inputs } : {}),
      ...overrides,
    },
    nowMs,
    deps.metadataRetentionDays,
  );
  const created = await deps.store.createRun(run, identity, nowMs);
  if (!created) {
    deps.log('lost run-creation race; adopting the recorded run', {
      repo: event.repo,
      workflow,
      abandonedNumber: runNumber,
    });
    return { run: undefined, created: false };
  }
  return { run, created: true };
}

async function gate(
  deps: LauncherDeps,
  run: RunItem,
  policy: 'queue' | 'supersede',
  nowMs: number,
): Promise<'started' | 'queued'> {
  // 6. Gate concurrency; 7. StartExecution. No group → unlimited concurrency.
  const group = run.concurrencyGroup;
  if (!group) {
    await deps.starter.startRun(run);
    return 'started';
  }
  const me = formatRunId(run);
  for (let attempt = 1; attempt <= GROUP_CLAIM_ATTEMPTS; attempt++) {
    const state = await deps.store.getGroup(group);
    const running = state?.running;
    if (!running || running === me) {
      if (await deps.store.claimRunningSlot(group, me, nowMs)) {
        await deps.starter.startRun(run);
        return 'started';
      }
      continue; // lost the slot race — re-read and queue behind the winner
    }
    if (state?.pending === me) {
      return 'queued'; // an earlier delivery already queued this run
    }
    const claimed = await deps.store.claimPendingSlot(
      group,
      me,
      {
        expectedRunning: running,
        expectedPending: state?.pending,
        markQueued: run,
        // Pending slot of one: a newer arrival replaces the waiter, which is
        // CANCELLED with reason superseded (spec §8.2).
        cancelReplaced: state?.pending ? parseRunId(state.pending) : undefined,
        // supersede: cancel the in-flight run via the standard
        // cancelRequested path; this run waits in pending for the hand-off.
        requestCancelOf: policy === 'supersede' ? parseRunId(running) : undefined,
      },
      nowMs,
    );
    if (claimed) {
      deps.log('run queued behind concurrency group', { group, runId: me, replaced: state?.pending });
      if (state?.pending) {
        await closeSupersededSynthCheck(deps, parseRunId(state.pending), nowMs);
      }
      return 'queued';
    }
  }
  throw new RetryLater(`could not claim concurrency group "${group}" for ${me}; retrying`);
}
