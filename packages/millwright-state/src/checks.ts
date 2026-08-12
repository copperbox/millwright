/**
 * Check-reporting domain model (spec §13.2): context naming, the desired
 * check state deciders write and the reporter converges, the backoff /
 * abandonment policy, and the content builders for synth and job checks.
 *
 * Everything here is pure. DynamoDB command shapes live with the runtime
 * (millwright-cdk); GitHub API calls live with the reporter.
 */

import { JobStatus, StepStatus } from './items';

export class CheckStateFormatError extends Error {}

// --- Context naming (one check per job, plus a synth check per workflow) ---

/**
 * Contexts join segments with " / ". Workflow and job names can contain
 * neither spaces nor "/" (millwright-workflows validates `[a-z0-9._-]+`),
 * so contexts parse unambiguously and never collide across workflows.
 */
const CONTEXT_SEPARATOR = ' / ';

/** The workflow/job name reserved for synth checks (`RESERVED_JOB_NAMES`). */
export const SYNTH_CONTEXT_SEGMENT = 'synth';

/**
 * Repo-level context reported by bootstrap-only executions — a single
 * idempotent writer per sha. Branch protection should require the gating
 * workflows' `<workflow> / synth` contexts instead, never this one.
 */
export const BOOTSTRAP_SYNTH_CONTEXT = 'millwright / synth';

function assertContextSegment(label: string, value: string): void {
  if (!value) {
    throw new CheckStateFormatError(`${label} must not be empty`);
  }
  if (/[#/\s]/.test(value)) {
    throw new CheckStateFormatError(
      `${label} must not contain "#", "/" or whitespace, got "${value}"`,
    );
  }
}

/** `<workflow> / <job>` — one check per job (spec §13.2 granularity). */
export function jobCheckContext(workflow: string, job: string): string {
  assertContextSegment('workflow', workflow);
  assertContextSegment('job', job);
  return `${workflow}${CONTEXT_SEPARATOR}${job}`;
}

/**
 * `<workflow> / synth` — the workflow-scoped synth check, created
 * `in_progress` at run start so a broken `workflows.ts` is always visible.
 */
export function synthCheckContext(workflow: string): string {
  return jobCheckContext(workflow, SYNTH_CONTEXT_SEGMENT);
}

// --- Desired check state -------------------------------------------------

/** GitHub check-run statuses millwright drives. */
export type CheckStatus = 'queued' | 'in_progress' | 'completed';

/** GitHub check-run conclusions millwright reports. */
export type CheckConclusion = 'success' | 'failure' | 'cancelled' | 'timed_out' | 'skipped';

const CHECK_STATUSES: readonly string[] = ['queued', 'in_progress', 'completed'];
const CHECK_CONCLUSIONS: readonly string[] = [
  'success',
  'failure',
  'cancelled',
  'timed_out',
  'skipped',
];

/**
 * What one check should show on GitHub. The decider serializes this into the
 * check item's `desired` attribute; the reporter posts it and copies the
 * exact serialization into `reported` on acknowledgement, so convergence is
 * a string equality.
 */
export interface DesiredCheckState {
  readonly status: CheckStatus;
  /** Present exactly when `status` is `completed`. */
  readonly conclusion?: CheckConclusion;
  readonly title: string;
  /** Markdown body (check-run `output.summary`); ignored by PAT statuses. */
  readonly summary: string;
  /** Deep link (CloudWatch for job checks); check `details_url` / status `target_url`. */
  readonly detailsUrl?: string;
}

/**
 * Canonical serialization: fixed key order, so two writes of the same state
 * are byte-identical and `reported === desired` is a reliable convergence
 * test regardless of who constructed the object.
 */
export function serializeDesiredCheckState(desired: DesiredCheckState): string {
  assertDesiredCheckState(desired);
  return JSON.stringify({
    status: desired.status,
    ...(desired.conclusion !== undefined ? { conclusion: desired.conclusion } : {}),
    title: desired.title,
    summary: desired.summary,
    ...(desired.detailsUrl !== undefined ? { detailsUrl: desired.detailsUrl } : {}),
  });
}

export function parseDesiredCheckState(raw: string): DesiredCheckState {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    throw new CheckStateFormatError('desired check state is not valid JSON');
  }
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new CheckStateFormatError('desired check state must be a JSON object');
  }
  const record = value as Record<string, unknown>;
  const desired: DesiredCheckState = {
    status: record.status as CheckStatus,
    ...(record.conclusion !== undefined
      ? { conclusion: record.conclusion as CheckConclusion }
      : {}),
    title: record.title as string,
    summary: record.summary as string,
    ...(record.detailsUrl !== undefined ? { detailsUrl: record.detailsUrl as string } : {}),
  };
  assertDesiredCheckState(desired);
  return desired;
}

function assertDesiredCheckState(desired: DesiredCheckState): void {
  if (!CHECK_STATUSES.includes(desired.status)) {
    throw new CheckStateFormatError(`unknown check status "${desired.status}"`);
  }
  if (desired.status === 'completed') {
    if (!CHECK_CONCLUSIONS.includes(desired.conclusion as string)) {
      throw new CheckStateFormatError('a completed check needs a valid conclusion');
    }
  } else if (desired.conclusion !== undefined) {
    throw new CheckStateFormatError(`a ${desired.status} check must not carry a conclusion`);
  }
  if (typeof desired.title !== 'string' || !desired.title) {
    throw new CheckStateFormatError('desired check state needs a non-empty title');
  }
  if (typeof desired.summary !== 'string') {
    throw new CheckStateFormatError('desired check state needs a summary string');
  }
  if (desired.detailsUrl !== undefined && typeof desired.detailsUrl !== 'string') {
    throw new CheckStateFormatError('detailsUrl must be a string when present');
  }
}

// --- Backoff and abandonment (spec §13.2 degradation) ---------------------

export const CHECK_BACKOFF_BASE_SECONDS = 60;
export const CHECK_BACKOFF_CAP_SECONDS = 15 * 60;
export const CHECK_ABANDON_AFTER_DAYS = 7;

/**
 * Delay before the attempt after `attemptsSoFar` failures: exponential from
 * 1 minute, capped at 15 minutes. A `Retry-After` from GitHub is a floor —
 * never retry sooner than asked, even past the cap — but a short one never
 * shortens the computed delay.
 */
export function checkBackoffSeconds(attemptsSoFar: number, retryAfterSeconds?: number): number {
  const exponent = Math.min(attemptsSoFar, 30);
  const computed = Math.min(CHECK_BACKOFF_CAP_SECONDS, CHECK_BACKOFF_BASE_SECONDS * 2 ** exponent);
  return retryAfterSeconds !== undefined && retryAfterSeconds > computed
    ? retryAfterSeconds
    : computed;
}

/**
 * Whether an unconverged item has aged past the 7-day abandonment deadline,
 * measured from the latest desired write. A late flush is still true for its
 * sha, so a fresh desired write legitimately restarts the clock.
 */
export function isCheckUnconvergedPastDeadline(desiredAt: string, nowMs: number): boolean {
  const writtenAt = Date.parse(desiredAt);
  if (Number.isNaN(writtenAt)) {
    return true;
  }
  return nowMs - writtenAt > CHECK_ABANDON_AFTER_DAYS * 24 * 60 * 60 * 1000;
}

// --- Content builders (spec §13.2 content) --------------------------------

const TERMINAL_CONCLUSIONS: Partial<Record<JobStatus, CheckConclusion>> = {
  SUCCEEDED: 'success',
  FAILED: 'failure',
  TIMED_OUT: 'timed_out',
  CANCELLED: 'cancelled',
  SKIPPED: 'skipped',
};

export function checkConclusionForJobStatus(status: JobStatus): CheckConclusion {
  const conclusion = TERMINAL_CONCLUSIONS[status];
  if (!conclusion) {
    throw new CheckStateFormatError(
      `job status ${status} is not terminal and has no check conclusion`,
    );
  }
  return conclusion;
}

export function desiredSynthStarted(runId: string): DesiredCheckState {
  return {
    status: 'in_progress',
    title: 'Validating workflow definitions',
    summary: `Run \`${runId}\`: synthesizing \`millwright/workflows.ts\`.`,
  };
}

export function desiredSynthSucceeded(runId: string, jobCount: number): DesiredCheckState {
  return {
    status: 'completed',
    conclusion: 'success',
    title: 'Workflow definitions are valid',
    summary: `Run \`${runId}\`: synth succeeded; ${jobCount} job check(s) created.`,
  };
}

/** Synth failed: the error goes in the summary so it is visible on GitHub. */
export function desiredSynthFailed(runId: string, error: string): DesiredCheckState {
  return {
    status: 'completed',
    conclusion: 'failure',
    title: 'Workflow definitions failed to synthesize',
    summary: `Run \`${runId}\`: synth failed.\n\n\`\`\`\n${error}\n\`\`\``,
  };
}

export interface StepReportLine {
  readonly name: string;
  readonly status: StepStatus;
  readonly durationSeconds?: number;
}

/** Everything a job check's markdown body renders. */
export interface JobCheckContent {
  /** Run identity as the CLI names it, e.g. `ci#142`. */
  readonly runId: string;
  readonly steps: readonly StepReportLine[];
  /** The failed step with the last lines of its log, when the job failed. */
  readonly failedStep?: { readonly name: string; readonly logTail: readonly string[] };
  /** e.g. `millwright logs ci#142 --job build --failed`. */
  readonly triageCommand?: string;
  /** CloudWatch deep link, becomes the check's details URL. */
  readonly detailsUrl?: string;
}

function formatDuration(seconds: number): string {
  const whole = Math.max(0, Math.round(seconds));
  const minutes = Math.floor(whole / 60);
  const rest = whole % 60;
  return minutes > 0 ? `${minutes}m ${rest}s` : `${rest}s`;
}

/** Markdown body: run number, per-step results/durations, failure tail, triage. */
export function jobCheckSummary(content: JobCheckContent): string {
  const lines: string[] = [`Run \`${content.runId}\``];
  if (content.steps.length > 0) {
    lines.push('', '| step | result | duration |', '| --- | --- | --- |');
    for (const step of content.steps) {
      const duration =
        step.durationSeconds !== undefined ? formatDuration(step.durationSeconds) : '—';
      lines.push(`| ${step.name} | ${step.status} | ${duration} |`);
    }
  }
  if (content.failedStep) {
    lines.push(
      '',
      `### Failed step: ${content.failedStep.name}`,
      '',
      '```',
      ...content.failedStep.logTail,
      '```',
    );
  }
  if (content.triageCommand) {
    lines.push('', `Triage: \`${content.triageCommand}\``);
  }
  return lines.join('\n');
}

/**
 * The desired state for a job check: `queued`/`in_progress` while pending,
 * or completed from the job's terminal status.
 */
export function desiredJobCheck(
  status: 'queued' | 'in_progress' | JobStatus,
  content: JobCheckContent,
): DesiredCheckState {
  const summary = jobCheckSummary(content);
  const detailsUrl = content.detailsUrl !== undefined ? { detailsUrl: content.detailsUrl } : {};
  if (status === 'queued' || status === 'in_progress') {
    const title = status === 'queued' ? 'Queued' : 'In progress';
    return { status, title, summary, ...detailsUrl };
  }
  const conclusion = checkConclusionForJobStatus(status);
  const titles: Record<CheckConclusion, string> = {
    success: 'Succeeded',
    failure: 'Failed',
    timed_out: 'Timed out',
    cancelled: 'Cancelled',
    skipped: 'Skipped',
  };
  return { status: 'completed', conclusion, title: titles[conclusion], summary, ...detailsUrl };
}

// --- PAT degradation: commit statuses (spec §13.1) ------------------------

export type CommitStatusState = 'pending' | 'success' | 'failure' | 'error';

export interface CommitStatusPayload {
  readonly state: CommitStatusState;
  /** GitHub caps status descriptions at 140 characters. */
  readonly description: string;
  readonly targetUrl?: string;
}

export const COMMIT_STATUS_DESCRIPTION_LIMIT = 140;

/**
 * PAT mode degrades a desired check state to a commit status with the same
 * context name so branch protection works identically. Statuses have no
 * markdown body: the title becomes the ≤140-char description.
 */
export function commitStatusForDesired(desired: DesiredCheckState): CommitStatusPayload {
  let state: CommitStatusState;
  if (desired.status !== 'completed') {
    state = 'pending';
  } else {
    switch (desired.conclusion) {
      case 'success':
      case 'skipped':
        state = 'success';
        break;
      case 'failure':
      case 'timed_out':
        state = 'failure';
        break;
      default:
        state = 'error';
        break;
    }
  }
  const description =
    desired.title.length <= COMMIT_STATUS_DESCRIPTION_LIMIT
      ? desired.title
      : `${desired.title.slice(0, COMMIT_STATUS_DESCRIPTION_LIMIT - 1)}…`;
  return {
    state,
    description,
    ...(desired.detailsUrl !== undefined ? { targetUrl: desired.detailsUrl } : {}),
  };
}
