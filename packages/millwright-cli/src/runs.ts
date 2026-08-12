/**
 * `millwright runs list` / `runs show` (spec §15): read-only views over the
 * state table — the CLI's source of truth, there being no web UI. Step rows
 * are display-plane only (§7.8) and rendered as such; log deep-links point
 * at CloudWatch.
 */

import { CheckStateItem, JobItem, RunItem, StepItem } from '@copperbox/millwright-state';
import { CommandError, manifestResource, requireManifestResource } from './config-plane';
import { DiscoverOptions, SsmClientLike, discoverDeployment } from './discovery';
import {
  StateReadContext,
  discoverWorkflows,
  formatQualifiedRunId,
  formatRunId,
  resolveRun,
} from './run-ref';
import {
  DynamoDocClientLike,
  listCheckStates,
  listRunDetail,
  queryNewestRuns,
} from './state-reads';

export interface RunsDeps {
  readonly ssm: SsmClientLike;
  readonly ddb: DynamoDocClientLike;
  readonly output: (line: string) => void;
  /** Region for CloudWatch deep links; omitted → links are left out. */
  readonly region?: string;
  readonly now?: () => Date;
}

export async function makeStateReadContext(
  ssm: SsmClientLike,
  ddb: DynamoDocClientLike,
  options: DiscoverOptions,
): Promise<StateReadContext> {
  const deployment = await discoverDeployment(ssm, options);
  const stateTable = requireManifestResource(deployment, 'stateTable', 'state table');
  return { ssm, ddb, deployment, stateTable };
}

function shortSha(sha: string | undefined): string {
  return sha ? sha.slice(0, 8) : '-';
}

/** `refs/heads/main` → `main`; tags keep a `tag:` marker; others verbatim. */
function shortRef(ref: string | undefined): string {
  if (!ref) {
    return '-';
  }
  if (ref.startsWith('refs/heads/')) {
    return ref.slice('refs/heads/'.length);
  }
  if (ref.startsWith('refs/tags/')) {
    return `tag:${ref.slice('refs/tags/'.length)}`;
  }
  return ref;
}

function formatDuration(startIso: string | undefined, endIso: string | undefined): string {
  if (!startIso || !endIso) {
    return '-';
  }
  const ms = Date.parse(endIso) - Date.parse(startIso);
  if (!Number.isFinite(ms) || ms < 0) {
    return '-';
  }
  const seconds = Math.round(ms / 1000);
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  const rest = seconds % 60;
  if (hours > 0) {
    return `${hours}h${String(minutes).padStart(2, '0')}m`;
  }
  if (minutes > 0) {
    return `${minutes}m${String(rest).padStart(2, '0')}s`;
  }
  return `${rest}s`;
}

function runDuration(run: RunItem, now: () => Date): string {
  const start = run.startedAt ?? run.createdAt;
  const end =
    run.finishedAt ??
    (run.status === 'RUNNING' ? now().toISOString() : undefined);
  return formatDuration(start, end);
}

/** Does a run's full ref match a `--ref` filter given as full or short name? */
function refMatches(run: RunItem, filter: string): boolean {
  return (
    run.ref === filter ||
    run.ref === `refs/heads/${filter}` ||
    run.ref === `refs/tags/${filter}`
  );
}

function renderTable(output: (line: string) => void, rows: string[][]): void {
  const widths = rows[0].map((_, column) =>
    Math.max(...rows.map((row) => row[column].length)),
  );
  for (const row of rows) {
    output(
      row
        .map((cell, column) => (column === row.length - 1 ? cell : cell.padEnd(widths[column])))
        .join('  ')
        .trimEnd(),
    );
  }
}

export interface RunsListOptions extends DiscoverOptions {
  readonly workflow?: string;
  readonly ref?: string;
  readonly status?: string;
  /** Rows shown after merging; also the per-workflow query depth. */
  readonly limit?: number;
}

export async function runsList(deps: RunsDeps, options: RunsListOptions = {}): Promise<RunItem[]> {
  const context = await makeStateReadContext(deps.ssm, deps.ddb, options);
  const limit = options.limit ?? 20;
  const statusFilter = options.status?.toUpperCase();

  let workflows = await discoverWorkflows(context);
  if (options.workflow) {
    workflows = workflows.filter(
      (w) => w.workflow === options.workflow || `${w.repo}/${w.workflow}` === options.workflow,
    );
    if (workflows.length === 0) {
      throw new CommandError(`no workflow "${options.workflow}" is registered`);
    }
  }

  const runs: RunItem[] = [];
  for (const { repo, workflow } of workflows) {
    for (const run of await queryNewestRuns(context.ddb, context.stateTable, repo, workflow, limit)) {
      if (options.ref && !refMatches(run, options.ref)) {
        continue;
      }
      if (statusFilter && run.status !== statusFilter) {
        continue;
      }
      runs.push(run);
    }
  }
  runs.sort((a, b) => (a.createdAt < b.createdAt ? 1 : a.createdAt > b.createdAt ? -1 : 0));
  const shown = runs.slice(0, limit);

  if (shown.length === 0) {
    deps.output('No runs found.');
    return shown;
  }
  const now = deps.now ?? (() => new Date());
  renderTable(deps.output, [
    ['RUN', 'REPO', 'STATUS', 'TRIGGER', 'REF', 'SHA', 'CREATED', 'DURATION'],
    ...shown.map((run) => [
      formatRunId(run),
      run.repo,
      run.status + (run.reason === 'superseded' ? ' (superseded)' : ''),
      run.trigger,
      shortRef(run.ref),
      shortSha(run.sha),
      run.createdAt,
      runDuration(run, now),
    ]),
  ]);
  return shown;
}

/** CloudWatch console deep link for one build's log stream (spec §15: no web UI of our own). */
export function cloudWatchLogLink(
  region: string,
  logGroup: string,
  logStream: string,
): string {
  const encode = (part: string) => encodeURIComponent(part).replace(/%/g, '$25');
  return (
    `https://${region}.console.aws.amazon.com/cloudwatch/home?region=${region}` +
    `#logsV2:log-groups/log-group/${encode(logGroup)}/log-events/${encode(logStream)}`
  );
}

function jobOrder(a: JobItem, b: JobItem): number {
  if (a.startedAt && b.startedAt && a.startedAt !== b.startedAt) {
    return a.startedAt < b.startedAt ? -1 : 1;
  }
  if (a.startedAt && !b.startedAt) {
    return -1;
  }
  if (!a.startedAt && b.startedAt) {
    return 1;
  }
  return a.job.localeCompare(b.job);
}

function describeJob(job: JobItem): string {
  const parts = [`${job.job}  ${job.status}`];
  const duration = formatDuration(job.startedAt, job.finishedAt);
  if (duration !== '-') {
    parts.push(duration);
  }
  if (job.skipReason) {
    parts.push(job.skipReason === 'upstream_failed' ? '(upstream failed)' : '(skipIf guard)');
  }
  if (job.reusedFrom) {
    parts.push(`(reused from ${job.reusedFrom})`);
  }
  return parts.join('  ');
}

function describeStep(step: StepItem): string {
  const name = step.name ?? `step ${step.stepIndex + 1}`;
  const duration = formatDuration(step.startedAt, step.finishedAt);
  return `${step.stepIndex + 1}. ${name}  ${step.status}${duration === '-' ? '' : `  ${duration}`}`;
}

function abandonedChecks(checks: readonly CheckStateItem[]): CheckStateItem[] {
  return checks.filter((check) => check.abandoned);
}

export interface RunsShowOptions extends DiscoverOptions {
  readonly run?: string;
}

export async function runsShow(deps: RunsDeps, options: RunsShowOptions = {}): Promise<RunItem> {
  const context = await makeStateReadContext(deps.ssm, deps.ddb, options);
  const run = await resolveRun(context, options.run);
  const { jobs, steps } = await listRunDetail(context.ddb, context.stateTable, run);
  const checks = await listCheckStates(context.ddb, context.stateTable, run.repo, run.sha);
  const logGroup = manifestResource(context.deployment, 'buildLogGroup');

  const header = [`${formatQualifiedRunId(run)}  ${run.status}`];
  if (run.reason) {
    header.push(`(${run.reason})`);
  }
  deps.output(header.join('  '));
  deps.output(`  trigger ${run.trigger}  ${shortRef(run.ref)} @ ${shortSha(run.sha)}`);
  deps.output(
    `  created ${run.createdAt}` +
      (run.startedAt ? `  started ${run.startedAt}` : '') +
      (run.finishedAt ? `  finished ${run.finishedAt}` : '') +
      `  duration ${runDuration(run, deps.now ?? (() => new Date()))}`,
  );
  if (run.rerunOf) {
    deps.output(`  rerun of ${run.rerunOf}`);
  }
  if (run.cancelRequested && run.status !== 'CANCELLED') {
    deps.output('  cancellation requested — waiting on the decider');
  }

  if (jobs.length === 0) {
    deps.output('  no jobs recorded yet');
  }
  for (const job of [...jobs].sort(jobOrder)) {
    deps.output(`  ${describeJob(job)}`);
    for (const step of steps
      .filter((step) => step.job === job.job)
      .sort((a, b) => a.stepIndex - b.stepIndex)) {
      deps.output(`    ${describeStep(step)}`);
    }
    if (job.logStreamName && logGroup && deps.region) {
      deps.output(`    logs: ${cloudWatchLogLink(deps.region, logGroup, job.logStreamName)}`);
    }
  }

  for (const check of abandonedChecks(checks)) {
    deps.output(
      `  check "${check.context}" abandoned — reporting to GitHub gave up` +
        (check.backoffAttempts ? ` after ${check.backoffAttempts} attempts` : '') +
        '; it will not retry',
    );
  }
  return run;
}
