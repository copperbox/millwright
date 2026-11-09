import {
  DesiredCheckState,
  JobCheckContent,
  JobStatus,
  RunCoordinates,
  RunModelWorkflow,
  StepItem,
  StepReportLine,
  cloudWatchLogLink,
  desiredJobCheck,
  jobCheckContext,
} from '@copperbox/millwright-state';
import { DesiredCheckWrite } from '../shared/checks';

/**
 * The decider's side of the check lifecycle (spec §13.2, #51): one check per
 * job, created `queued` the first time the loop sees the job, `in_progress`
 * once a dispatch is claimed, completed from the terminal status. Pure: the
 * iteration hands over what each check last reflected and what the job rows
 * say now, and gets back the desired-state upserts to send.
 *
 * Writes happen on phase changes only — a parked loop re-entering every
 * 60 s must not re-write unchanged checks — except when the run goes
 * terminal, where every job is written unconditionally. That final pass is
 * the safety net for a crash between a check write and its `checkedStatus`
 * mark: an identical desired serialization is a no-op for the reporter
 * (`reported === desired`), so the redundancy costs one stream record.
 *
 * The phase comparand is the row's `checkedStatus` (what the check last
 * reflected), never the status read at the start of the iteration: the
 * build-events handler projects terminal statuses onto rows BEFORE waking
 * the loop, so by the time the iteration reads its rows the new status is
 * already there and a before/after snapshot of the same iteration would
 * never see it change.
 */

/** Where the build project's CloudWatch logs live, for `details_url` links. */
export interface BuildLogLocation {
  readonly region: string;
  readonly logGroup: string;
}

export interface JobCheckPlanInput {
  readonly coords: RunCoordinates;
  readonly sha: string;
  readonly workflow: RunModelWorkflow;
  /**
   * This iteration's `RunItem.deciderSequence`: the ordering fence stamped
   * onto every write so a stalled earlier iteration cannot overwrite these.
   */
  readonly sequence: number;
  /** Per job, the status its check last reflected; absent = never written. */
  readonly checked: ReadonlyMap<string, JobStatus>;
  /** Job statuses after this iteration's row writes; absent = no row yet. */
  readonly after: ReadonlyMap<string, JobStatus>;
  /** The run's step rows (display plane) for the per-step table. */
  readonly steps: readonly StepItem[];
  /** Per job, the build's CloudWatch log stream once CodeBuild reported it. */
  readonly logStreams: ReadonlyMap<string, string>;
  /** Absent = checks carry no details link. */
  readonly logs?: BuildLogLocation;
  /**
   * The loop's first iteration — synth just finished: jobs without a row
   * are created `queued`. Later iterations leave row-less jobs alone (they
   * are still queued, and a parked loop re-enters every minute).
   */
  readonly firstIteration: boolean;
  /** The run finished this iteration: write every job. */
  readonly terminal: boolean;
}

/** One check write plus the job status it projects, for the row's `checkedStatus`. */
export interface PlannedJobCheck {
  readonly job: string;
  readonly status: JobStatus;
  readonly write: DesiredCheckWrite;
}

const NO_CONTENT: JobCheckContent = { runId: '', steps: [] };

function samePhase(a: DesiredCheckState, b: DesiredCheckState): boolean {
  return a.status === b.status && a.conclusion === b.conclusion;
}

function stepLines(steps: readonly StepItem[]): StepReportLine[] {
  return [...steps]
    .sort((a, b) => a.stepIndex - b.stepIndex)
    .map((step) => {
      const started = step.startedAt ? Date.parse(step.startedAt) : NaN;
      const finished = step.finishedAt ? Date.parse(step.finishedAt) : NaN;
      const duration =
        Number.isFinite(started) && Number.isFinite(finished)
          ? Math.max(0, (finished - started) / 1000)
          : undefined;
      return {
        name: step.name ?? `step ${step.stepIndex + 1}`,
        status: step.status,
        ...(duration !== undefined ? { durationSeconds: duration } : {}),
      };
    });
}

export function planJobCheckWrites(input: JobCheckPlanInput): PlannedJobCheck[] {
  const { coords } = input;
  const label = `${coords.workflow}#${coords.runNumber}`;
  // Repo-qualified (spec §15): a bare `ci#7` is ambiguous to the CLI when two
  // watched repos both define a `ci` workflow.
  const qualifiedLabel = `${coords.repo}/${label}`;
  const stepsByJob = new Map<string, StepItem[]>();
  for (const step of input.steps) {
    stepsByJob.set(step.job, [...(stepsByJob.get(step.job) ?? []), step]);
  }

  const planned: PlannedJobCheck[] = [];
  for (const job of input.workflow.jobs) {
    const status = input.after.get(job.name) ?? 'PENDING';
    const stream = input.logStreams.get(job.name);
    const content: JobCheckContent = {
      runId: label,
      steps: stepLines(stepsByJob.get(job.name) ?? []),
      ...(status === 'FAILED' || status === 'TIMED_OUT'
        ? { triageCommand: `millwright logs ${qualifiedLabel} --job ${job.name}` }
        : {}),
      ...(input.logs && stream
        ? { detailsUrl: cloudWatchLogLink(input.logs.region, input.logs.logGroup, stream) }
        : {}),
    };
    const desired = desiredJobCheck(status, content);
    const checkedStatus = input.checked.get(job.name);
    const opening = checkedStatus === undefined && input.firstIteration;
    const reflected = desiredJobCheck(checkedStatus ?? 'PENDING', NO_CONTENT);
    if (!input.terminal && !opening && samePhase(reflected, desired)) {
      continue;
    }
    planned.push({
      job: job.name,
      status,
      write: {
        repo: coords.repo,
        sha: input.sha,
        context: jobCheckContext(coords.workflow, job.name),
        ownerRun: label,
        ownerRunNumber: coords.runNumber,
        ownerSequence: input.sequence,
        desired,
      },
    });
  }
  return planned;
}
