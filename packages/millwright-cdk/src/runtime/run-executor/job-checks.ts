import {
  DesiredCheckState,
  JobCheckContent,
  JobStatus,
  RunCoordinates,
  RunModelWorkflow,
  StepItem,
  StepReportLine,
  desiredJobCheck,
  jobCheckContext,
} from '@copperbox/millwright-state';
import { DesiredCheckWrite } from '../shared/checks';

/**
 * The decider's side of the check lifecycle (spec §13.2, #51): one check per
 * job, created `queued` the first time the loop sees the job, `in_progress`
 * once a dispatch is claimed, completed from the terminal status. Pure: the
 * iteration hands over what it knew before its writes and what it wrote, and
 * gets back the desired-state upserts to send.
 *
 * Writes happen on phase changes only — a parked loop re-entering every
 * 60 s must not re-write unchanged checks — except when the run goes
 * terminal, where every job is written unconditionally. That final pass is
 * the safety net for a crash between a job-row write and its check write:
 * an identical desired serialization is a no-op for the reporter
 * (`reported === desired`), so the redundancy costs one stream record.
 */

export interface JobCheckPlanInput {
  readonly coords: RunCoordinates;
  readonly sha: string;
  readonly workflow: RunModelWorkflow;
  /** Job statuses as read at the start of the iteration; absent = no row yet. */
  readonly before: ReadonlyMap<string, JobStatus>;
  /** Job statuses after this iteration's row writes. */
  readonly after: ReadonlyMap<string, JobStatus>;
  /** The run's step rows (display plane) for the per-step table. */
  readonly steps: readonly StepItem[];
  /**
   * The loop's first iteration — synth just finished: jobs without a row
   * are created `queued`. Later iterations leave row-less jobs alone (they
   * are still queued, and a parked loop re-enters every minute).
   */
  readonly firstIteration: boolean;
  /** The run finished this iteration: write every job. */
  readonly terminal: boolean;
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

export function planJobCheckWrites(input: JobCheckPlanInput): DesiredCheckWrite[] {
  const { coords } = input;
  const label = `${coords.workflow}#${coords.runNumber}`;
  const stepsByJob = new Map<string, StepItem[]>();
  for (const step of input.steps) {
    stepsByJob.set(step.job, [...(stepsByJob.get(step.job) ?? []), step]);
  }

  const writes: DesiredCheckWrite[] = [];
  for (const job of input.workflow.jobs) {
    const status = input.after.get(job.name) ?? 'PENDING';
    const content: JobCheckContent = {
      runId: label,
      steps: stepLines(stepsByJob.get(job.name) ?? []),
      ...(status === 'FAILED' || status === 'TIMED_OUT'
        ? { triageCommand: `millwright logs ${label} --job ${job.name}` }
        : {}),
    };
    const desired = desiredJobCheck(status, content);
    const priorStatus = input.before.get(job.name);
    const opening = priorStatus === undefined && input.firstIteration;
    const prior = desiredJobCheck(priorStatus ?? 'PENDING', NO_CONTENT);
    if (!input.terminal && !opening && samePhase(prior, desired)) {
      continue;
    }
    writes.push({
      repo: coords.repo,
      sha: input.sha,
      context: jobCheckContext(coords.workflow, job.name),
      ownerRun: label,
      ownerRunNumber: coords.runNumber,
      desired,
    });
  }
  return writes;
}
