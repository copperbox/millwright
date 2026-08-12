/**
 * `millwright logs [-f] [<run>] [--job <name>] [--failed] [--full]`
 * (spec §15): job logs straight from the deployment's CloudWatch log group.
 * Tailing is a polled `GetLogEvents` loop at ~2 s cadence — no push channel
 * exists and none is needed at CLI-watching scale. `--failed` narrows to
 * failed jobs; `--full` dumps a job's whole stream from the head.
 */

import { GetLogEventsCommand } from '@aws-sdk/client-cloudwatch-logs';
import { JobItem, JobStatus, RunItem } from '@copperbox/millwright-state';
import { CommandError, requireManifestResource } from './config-plane';
import { DiscoverOptions, SsmClientLike } from './discovery';
import { formatRunId, resolveRun } from './run-ref';
import { makeStateReadContext } from './runs';
import { DynamoDocClientLike, getRun, listRunDetail } from './state-reads';

/** The slice of CloudWatchLogsClient the CLI uses; tests inject a fake. */
export interface CloudWatchLogsClientLike {
  send(command: unknown): Promise<any>;
}

export interface LogsDeps {
  readonly ssm: SsmClientLike;
  readonly ddb: DynamoDocClientLike;
  readonly cwl: CloudWatchLogsClientLike;
  readonly output: (line: string) => void;
  /** Injectable for tests. @default setTimeout */
  readonly sleep?: (ms: number) => Promise<void>;
  /** Tail poll cadence. @default 2000 (spec §15: ~2 s). */
  readonly pollIntervalMs?: number;
}

export interface LogsOptions extends DiscoverOptions {
  readonly run?: string;
  readonly job?: string;
  readonly failed?: boolean;
  readonly full?: boolean;
  readonly follow?: boolean;
}

const TERMINAL_RUN_STATUSES: ReadonlySet<string> = new Set(['SUCCEEDED', 'FAILED', 'CANCELLED']);
const FAILED_JOB_STATUSES: ReadonlySet<JobStatus> = new Set(['FAILED', 'TIMED_OUT']);

interface LogEvent {
  readonly message?: string;
}

interface EventsPage {
  readonly events: LogEvent[];
  readonly forwardToken?: string;
}

async function getEvents(
  cwl: CloudWatchLogsClientLike,
  logGroup: string,
  stream: string,
  options: { startFromHead?: boolean; nextToken?: string },
): Promise<EventsPage> {
  const page = await cwl.send(
    new GetLogEventsCommand({
      logGroupName: logGroup,
      logStreamName: stream,
      startFromHead: options.startFromHead,
      nextToken: options.nextToken,
    }),
  );
  return { events: (page.events ?? []) as LogEvent[], forwardToken: page.nextForwardToken };
}

function printEvents(
  output: (line: string) => void,
  events: readonly LogEvent[],
  prefix: string,
): void {
  for (const event of events) {
    for (const line of (event.message ?? '').replace(/\n$/, '').split('\n')) {
      output(`${prefix}${line}`);
    }
  }
}

function selectJobs(jobs: readonly JobItem[], options: LogsOptions): JobItem[] {
  let selected = [...jobs];
  if (options.job !== undefined) {
    selected = selected.filter((job) => job.job === options.job);
    if (selected.length === 0) {
      const known = jobs.map((job) => job.job).sort().join(', ') || '(none recorded yet)';
      throw new CommandError(`no job "${options.job}" in this run — jobs: ${known}`);
    }
  }
  if (options.failed) {
    selected = selected.filter((job) => FAILED_JOB_STATUSES.has(job.status));
  }
  return selected.sort((a, b) => {
    if (a.startedAt && b.startedAt && a.startedAt !== b.startedAt) {
      return a.startedAt < b.startedAt ? -1 : 1;
    }
    return a.job.localeCompare(b.job);
  });
}

async function dump(
  deps: LogsDeps,
  logGroup: string,
  jobs: readonly JobItem[],
  full: boolean,
): Promise<void> {
  for (const job of jobs) {
    if (jobs.length > 1) {
      deps.output(`=== ${job.job} (${job.status}) ===`);
    }
    if (!job.logStreamName) {
      deps.output(`(no logs yet for ${job.job} — status ${job.status})`);
      continue;
    }
    if (full) {
      let token: string | undefined;
      let startFromHead = true;
      for (;;) {
        const page = await getEvents(deps.cwl, logGroup, job.logStreamName, {
          startFromHead,
          nextToken: token,
        });
        printEvents(deps.output, page.events, '');
        startFromHead = false;
        if (!page.forwardToken || page.forwardToken === token || page.events.length === 0) {
          break;
        }
        token = page.forwardToken;
      }
    } else {
      const page = await getEvents(deps.cwl, logGroup, job.logStreamName, { startFromHead: false });
      printEvents(deps.output, page.events, '');
    }
  }
}

async function follow(
  deps: LogsDeps,
  logGroup: string,
  run: RunItem,
  options: LogsOptions,
): Promise<void> {
  const context = await makeStateReadContext(deps.ssm, deps.ddb, options);
  const sleep = deps.sleep ?? ((ms: number) => new Promise((resolve) => setTimeout(resolve, ms)));
  const interval = deps.pollIntervalMs ?? 2_000;
  // Streams we started watching mid-run begin at the tail; streams that
  // appear while following begin at the head so nothing of theirs is lost.
  const tokens = new Map<string, string | undefined>();
  let firstIteration = true;
  let current: RunItem = run;

  for (;;) {
    const { jobs } = await listRunDetail(context.ddb, context.stateTable, current);
    const watched = selectJobs(jobs, options).filter((job) => job.logStreamName);
    const multiple = watched.length > 1;
    let printed = 0;
    for (const job of watched) {
      const stream = job.logStreamName!;
      const prefix = multiple ? `[${job.job}] ` : '';
      const known = tokens.has(stream);
      const page = await getEvents(
        deps.cwl,
        logGroup,
        stream,
        known
          ? { nextToken: tokens.get(stream) }
          : { startFromHead: !firstIteration },
      );
      if (known && page.forwardToken === tokens.get(stream)) {
        continue;
      }
      printEvents(deps.output, page.events, prefix);
      printed += page.events.length;
      tokens.set(stream, page.forwardToken);
    }
    firstIteration = false;
    const refreshed = await getRun(context.ddb, context.stateTable, current);
    current = refreshed ?? current;
    if (TERMINAL_RUN_STATUSES.has(current.status) && printed === 0) {
      deps.output(
        `(run ${formatRunId(current)} ${current.status.toLowerCase()} — ` +
          `${tokens.size > 0 ? 'end of logs' : 'no matching logs'})`,
      );
      return;
    }
    await sleep(interval);
  }
}

export async function logs(deps: LogsDeps, options: LogsOptions = {}): Promise<void> {
  if (options.follow && options.full) {
    throw new CommandError('-f and --full cannot be combined — tail or dump, not both');
  }
  const context = await makeStateReadContext(deps.ssm, deps.ddb, options);
  const logGroup = requireManifestResource(context.deployment, 'buildLogGroup', 'build log group');
  const run = await resolveRun(context, options.run);

  if (options.follow) {
    await follow(deps, logGroup, run, options);
    return;
  }
  const { jobs } = await listRunDetail(context.ddb, context.stateTable, run);
  const selected = selectJobs(jobs, options);
  if (selected.length === 0) {
    deps.output(
      options.failed
        ? `run ${formatRunId(run)} has no failed jobs`
        : `run ${formatRunId(run)} has no jobs recorded yet`,
    );
    return;
  }
  await dump(deps, logGroup, selected, options.full ?? false);
}
