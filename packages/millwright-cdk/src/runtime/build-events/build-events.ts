import {
  BuildMappingItem,
  JobStatus,
  RunCoordinates,
  RunItem,
} from '@copperbox/millwright-state';
import { JobProjectionPatch } from '../shared/jobs';

/**
 * Build-events handler core (spec C7): on every CodeBuild build-state change,
 * map the build to its run and job via the `BUILD#` item, converge the job
 * row's display projection, and wake the run's token-wait so dispatch-on-
 * completion latency is the event's, not the 60 s timeout's.
 *
 * The wake is pure signal: the decider re-reads cancelRequested, job states
 * and CodeBuild ground truth on every entry, so duplicate, late or entirely
 * spurious wakes are harmless — and with this handler disabled, runs still
 * complete via the timeout reconciliation path.
 */

export interface CodeBuildStateChangeEvent {
  readonly source?: string;
  readonly 'detail-type'?: string;
  readonly detail?: {
    readonly 'build-status'?: string;
    /** The build ARN (EventBridge's field name, not actually the id). */
    readonly 'build-id'?: string;
    readonly 'project-name'?: string;
    readonly 'additional-information'?: {
      readonly logs?: { readonly 'stream-name'?: string };
    };
  };
}

export interface BuildEventsStore {
  getBuildMapping(buildId: string): Promise<BuildMappingItem | undefined>;
  writeJobProjection(
    coords: RunCoordinates,
    job: string,
    patch: JobProjectionPatch,
    nowMs: number,
  ): Promise<void>;
  /** Stamp the short post-terminality TTL onto the `BUILD#` item (§9.1). */
  stampBuildMappingTtl(buildId: string, nowMs: number): Promise<void>;
  getRun(coords: RunCoordinates): Promise<RunItem | undefined>;
}

export interface WakeSender {
  /** SendTaskSuccess best-effort; 'stale' when the token was already consumed. */
  wake(taskToken: string): Promise<'sent' | 'stale'>;
}

export interface BuildEventsDeps {
  readonly store: BuildEventsStore;
  readonly sender: WakeSender;
  readonly log: (message: string, fields?: Record<string, unknown>) => void;
}

export type BuildEventDisposition = 'ignored' | 'unmapped' | 'no-token' | 'woke' | 'stale-token';

/** `arn:aws:codebuild:…:build/<project>:<uuid>` → `<project>:<uuid>`. */
export function buildIdFromArn(buildArn: string): string | undefined {
  const marker = ':build/';
  const index = buildArn.indexOf(marker);
  return index < 0 ? undefined : buildArn.slice(index + marker.length) || undefined;
}

const TERMINAL_BUILD_STATUSES = ['SUCCEEDED', 'FAILED', 'FAULT', 'TIMED_OUT', 'STOPPED'];

/**
 * Display projection for an event's build-status. FAULTs are left to the
 * decider, which knows whether a bounded retry remains.
 */
function projectionFor(buildStatus: string | undefined): JobStatus | undefined {
  switch (buildStatus) {
    case 'IN_PROGRESS':
      return 'RUNNING';
    case 'SUCCEEDED':
      return 'SUCCEEDED';
    case 'FAILED':
      return 'FAILED';
    case 'TIMED_OUT':
      return 'TIMED_OUT';
    case 'STOPPED':
      return 'CANCELLED';
    default:
      return undefined;
  }
}

export async function processBuildStateChange(
  deps: BuildEventsDeps,
  event: CodeBuildStateChangeEvent,
  nowMs: number,
): Promise<BuildEventDisposition> {
  const { store, sender, log } = deps;
  const buildArn = event.detail?.['build-id'];
  const buildId = buildArn ? buildIdFromArn(buildArn) : undefined;
  if (!buildId) {
    return 'ignored';
  }

  const mapping = await store.getBuildMapping(buildId);
  if (!mapping) {
    // Not one of ours (or the mapping already aged out) — e.g. the synth
    // build, whose completion rides its own token, or a foreign project.
    return 'unmapped';
  }
  const coords: RunCoordinates = {
    repo: mapping.repo,
    workflow: mapping.workflow,
    runNumber: mapping.runNumber,
  };

  const buildStatus = event.detail?.['build-status'];
  const projected = projectionFor(buildStatus);
  if (projected) {
    await store.writeJobProjection(
      coords,
      mapping.job,
      {
        status: projected,
        logStreamName: event.detail?.['additional-information']?.logs?.['stream-name'],
        finishedAt: TERMINAL_BUILD_STATUSES.includes(buildStatus!)
          ? new Date(nowMs).toISOString()
          : undefined,
        // Fence on the build this event is about: a retry may have replaced
        // the row's build, and a late event must not clobber the new attempt.
        ifBuildId: buildId,
      },
      nowMs,
    );
  }
  if (TERMINAL_BUILD_STATUSES.includes(buildStatus ?? '')) {
    await store.stampBuildMappingTtl(buildId, nowMs);
  }

  const run = await store.getRun(coords);
  if (!run?.taskToken) {
    // Between token generations, or the run is already terminal; the
    // decider's 60 s timeout reconciliation covers this window.
    return 'no-token';
  }
  const wake = await sender.wake(run.taskToken);
  log('build event processed', { buildId, buildStatus, job: mapping.job, wake });
  return wake === 'sent' ? 'woke' : 'stale-token';
}
