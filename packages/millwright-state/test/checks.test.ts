import { describe, expect, it } from 'vitest';
import {
  BOOTSTRAP_SYNTH_CONTEXT,
  CHECK_ABANDON_AFTER_DAYS,
  CHECK_BACKOFF_BASE_SECONDS,
  CHECK_BACKOFF_CAP_SECONDS,
  CheckStateFormatError,
  DesiredCheckState,
  checkBackoffSeconds,
  checkConclusionForJobStatus,
  commitStatusForDesired,
  desiredJobCheck,
  desiredSynthFailed,
  desiredSynthStarted,
  desiredSynthSucceeded,
  isCheckUnconvergedPastDeadline,
  jobCheckContext,
  jobCheckSummary,
  parseDesiredCheckState,
  serializeDesiredCheckState,
  synthCheckContext,
} from '../src';

const NOW = Date.parse('2026-08-12T06:00:00Z');

describe('check contexts (spec §13.2 granularity)', () => {
  it('names job checks "<workflow> / <job>"', () => {
    expect(jobCheckContext('ci', 'build')).toBe('ci / build');
  });

  it('names the workflow-scoped synth check "<workflow> / synth"', () => {
    expect(synthCheckContext('ci')).toBe('ci / synth');
  });

  it('reserves the repo-level bootstrap context', () => {
    expect(BOOTSTRAP_SYNTH_CONTEXT).toBe('millwright / synth');
  });

  it('rejects empty or "#"-carrying segments', () => {
    expect(() => jobCheckContext('', 'build')).toThrow();
    expect(() => jobCheckContext('ci', 'a#b')).toThrow();
    expect(() => synthCheckContext('')).toThrow();
  });
});

describe('desired-state serialization', () => {
  const completed: DesiredCheckState = {
    status: 'completed',
    conclusion: 'success',
    title: 'build succeeded',
    summary: 'Run `ci#142`',
    detailsUrl: 'https://console.aws.amazon.com/cloudwatch/deep-link',
  };

  it('round-trips through serialize/parse', () => {
    expect(parseDesiredCheckState(serializeDesiredCheckState(completed))).toEqual(completed);
    const inProgress: DesiredCheckState = {
      status: 'in_progress',
      title: 'synth',
      summary: 'validating workflows.ts',
    };
    expect(parseDesiredCheckState(serializeDesiredCheckState(inProgress))).toEqual(inProgress);
  });

  it('is canonical: field order never depends on construction order', () => {
    const reordered = {
      detailsUrl: completed.detailsUrl,
      summary: completed.summary,
      title: completed.title,
      conclusion: 'success',
      status: 'completed',
    } as DesiredCheckState;
    expect(serializeDesiredCheckState(reordered)).toBe(serializeDesiredCheckState(completed));
  });

  it('rejects malformed payloads', () => {
    expect(() => parseDesiredCheckState('not json')).toThrow(CheckStateFormatError);
    expect(() => parseDesiredCheckState('{"status":"weird","title":"t","summary":"s"}')).toThrow(
      CheckStateFormatError,
    );
    expect(() => parseDesiredCheckState('{"status":"completed","title":"t","summary":"s"}')).toThrow(
      /conclusion/,
    );
    expect(() =>
      parseDesiredCheckState('{"status":"queued","conclusion":"success","title":"t","summary":"s"}'),
    ).toThrow(/conclusion/);
  });
});

describe('backoff policy (spec §13.2 degradation)', () => {
  it('doubles from 1 minute to the 15-minute cap', () => {
    expect(CHECK_BACKOFF_BASE_SECONDS).toBe(60);
    expect(CHECK_BACKOFF_CAP_SECONDS).toBe(15 * 60);
    expect(checkBackoffSeconds(0)).toBe(60);
    expect(checkBackoffSeconds(1)).toBe(120);
    expect(checkBackoffSeconds(3)).toBe(480);
    expect(checkBackoffSeconds(4)).toBe(900);
    expect(checkBackoffSeconds(50)).toBe(900);
  });

  it('honors a Retry-After longer than the computed delay, even past the cap', () => {
    expect(checkBackoffSeconds(0, 300)).toBe(300);
    expect(checkBackoffSeconds(10, 3600)).toBe(3600);
  });

  it('never retries sooner than the computed delay on a short Retry-After', () => {
    expect(checkBackoffSeconds(4, 30)).toBe(900);
  });

  it('abandons only after 7 unconverged days from the latest desired write', () => {
    expect(CHECK_ABANDON_AFTER_DAYS).toBe(7);
    const desiredAt = new Date(NOW).toISOString();
    const justUnder = NOW + 7 * 24 * 3600 * 1000 - 1;
    const past = NOW + 7 * 24 * 3600 * 1000 + 1;
    expect(isCheckUnconvergedPastDeadline(desiredAt, justUnder)).toBe(false);
    expect(isCheckUnconvergedPastDeadline(desiredAt, past)).toBe(true);
  });
});

describe('job-status mapping', () => {
  it('maps terminal job statuses onto check conclusions', () => {
    expect(checkConclusionForJobStatus('SUCCEEDED')).toBe('success');
    expect(checkConclusionForJobStatus('FAILED')).toBe('failure');
    expect(checkConclusionForJobStatus('TIMED_OUT')).toBe('timed_out');
    expect(checkConclusionForJobStatus('CANCELLED')).toBe('cancelled');
    expect(checkConclusionForJobStatus('SKIPPED')).toBe('skipped');
  });

  it('refuses non-terminal statuses', () => {
    expect(() => checkConclusionForJobStatus('RUNNING')).toThrow(/terminal/);
  });
});

describe('synth check content (spec §13.2 content)', () => {
  it('starts in_progress with the run id in the summary', () => {
    const desired = desiredSynthStarted('ci#142');
    expect(desired.status).toBe('in_progress');
    expect(desired.summary).toContain('ci#142');
  });

  it('completes successfully with the job count', () => {
    const desired = desiredSynthSucceeded('ci#142', 3);
    expect(desired).toMatchObject({ status: 'completed', conclusion: 'success' });
    expect(desired.summary).toContain('3');
  });

  it('fails with the synth error verbatim in the summary', () => {
    const desired = desiredSynthFailed('ci#142', 'workflows.ts:12 unknown trigger "pushh"');
    expect(desired).toMatchObject({ status: 'completed', conclusion: 'failure' });
    expect(desired.summary).toContain('workflows.ts:12 unknown trigger "pushh"');
  });
});

describe('job check content (spec §13.2 content)', () => {
  it('carries run number, per-step conclusions and durations, the failed step tail, and the triage command', () => {
    const summary = jobCheckSummary({
      runId: 'ci#142',
      steps: [
        { name: 'checkout', status: 'SUCCEEDED', durationSeconds: 4 },
        { name: 'test', status: 'FAILED', durationSeconds: 61 },
        { name: 'package', status: 'SKIPPED' },
      ],
      failedStep: { name: 'test', logTail: ['expect(received).toBe(expected)', '1 test failed'] },
      triageCommand: 'millwright logs ci#142 --job build --failed',
    });
    expect(summary).toContain('ci#142');
    expect(summary).toContain('checkout');
    expect(summary).toContain('4s');
    expect(summary).toContain('1m 1s');
    expect(summary).toContain('1 test failed');
    expect(summary).toContain('millwright logs ci#142 --job build --failed');
  });

  it('builds a queued desired state before the job starts', () => {
    const desired = desiredJobCheck('queued', { runId: 'ci#142', steps: [] });
    expect(desired.status).toBe('queued');
    expect(desired.summary).toContain('ci#142');
  });

  it('builds a completed desired state from a terminal job status', () => {
    const desired = desiredJobCheck('SUCCEEDED', { runId: 'ci#142', steps: [] });
    expect(desired).toMatchObject({ status: 'completed', conclusion: 'success' });
  });
});

describe('PAT-mode commit statuses (spec §13.1)', () => {
  it('maps queued and in_progress to pending, conclusions to states', () => {
    expect(commitStatusForDesired({ status: 'queued', title: 't', summary: 's' }).state).toBe(
      'pending',
    );
    expect(commitStatusForDesired({ status: 'in_progress', title: 't', summary: 's' }).state).toBe(
      'pending',
    );
    const state = (conclusion: 'success' | 'failure' | 'timed_out' | 'cancelled' | 'skipped') =>
      commitStatusForDesired({ status: 'completed', conclusion, title: 't', summary: 's' }).state;
    expect(state('success')).toBe('success');
    expect(state('skipped')).toBe('success');
    expect(state('failure')).toBe('failure');
    expect(state('timed_out')).toBe('failure');
    expect(state('cancelled')).toBe('error');
  });

  it('caps the description at 140 characters and passes the details URL through', () => {
    const status = commitStatusForDesired({
      status: 'completed',
      conclusion: 'failure',
      title: 'x'.repeat(200),
      summary: 'ignored — statuses have no markdown body',
      detailsUrl: 'https://example.test/logs',
    });
    expect(status.description.length).toBeLessThanOrEqual(140);
    expect(status.description.endsWith('…')).toBe(true);
    expect(status.targetUrl).toBe('https://example.test/logs');
  });
});
