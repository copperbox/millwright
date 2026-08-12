import { GetLogEventsCommand } from '@aws-sdk/client-cloudwatch-logs';
import { jobKey, runKey } from '@copperbox/millwright-state';
import { describe, expect, it } from 'vitest';
import { CloudWatchLogsClientLike, LogsDeps, logs } from '../src/logs';
import { FakeDdb } from './fake-ddb';
import { FakeSsm } from './fake-ssm';

const TABLE = 'millwright-prod-state';
const LOG_GROUP = '/millwright/prod/builds';
const COORDS = { repo: 'acme/api', workflow: 'ci', runNumber: 7 };

/**
 * In-memory GetLogEvents: tokens are `t<index>`; a poll past the end returns
 * the same forward token, exactly like the real API.
 */
class FakeCwl implements CloudWatchLogsClientLike {
  readonly streams = new Map<string, string[]>();
  readonly pageSize: number;

  constructor(pageSize = 100) {
    this.pageSize = pageSize;
  }

  append(stream: string, ...messages: string[]): void {
    this.streams.set(stream, [...(this.streams.get(stream) ?? []), ...messages]);
  }

  async send(command: unknown): Promise<any> {
    if (!(command instanceof GetLogEventsCommand)) {
      throw new Error('FakeCwl: unexpected command');
    }
    const { logGroupName, logStreamName, startFromHead, nextToken } = command.input;
    if (logGroupName !== LOG_GROUP) {
      throw new Error(`FakeCwl: unexpected log group ${logGroupName}`);
    }
    const events = this.streams.get(logStreamName!) ?? [];
    let from: number;
    if (nextToken !== undefined) {
      from = Number(nextToken.slice(1));
    } else if (startFromHead) {
      from = 0;
    } else {
      from = Math.max(0, events.length - this.pageSize);
    }
    const slice = events.slice(from, from + this.pageSize);
    return {
      events: slice.map((message, i) => ({ message, timestamp: from + i })),
      nextForwardToken: `t${from + slice.length}`,
    };
  }
}

function runItem(overrides: Record<string, unknown> = {}) {
  return {
    ...runKey(COORDS),
    ...COORDS,
    status: 'FAILED',
    trigger: 'push',
    ref: 'refs/heads/main',
    sha: 'c0ffee0000000000000000000000000000000000',
    createdAt: '2026-08-12T07:00:00Z',
    originalStartedAt: '2026-08-12T07:00:00Z',
    expiresAt: 1790000000,
    ...overrides,
  };
}

function jobItem(job: string, overrides: Record<string, unknown> = {}) {
  return {
    ...jobKey(COORDS, job),
    ...COORDS,
    job,
    status: 'SUCCEEDED',
    logStreamName: `stream/${job}`,
    startedAt: '2026-08-12T07:01:00Z',
    expiresAt: 1790000000,
    ...overrides,
  };
}

function fixture(cwl: FakeCwl) {
  const ssm = new FakeSsm();
  ssm.setManifest('prod', { stateTable: TABLE, buildLogGroup: LOG_GROUP });
  ssm.set('/millwright/prod/repos/acme/api/config', '{}');
  const ddb = new FakeDdb();
  ddb.put(TABLE, {
    pk: 'REG#acme/api',
    sk: 'REF#refs/heads/main',
    repo: 'acme/api',
    ref: 'refs/heads/main',
    schemaVersion: 1,
    workflows: { ci: { triggers: {} } },
  });
  const lines: string[] = [];
  const deps: LogsDeps = { ssm, ddb, cwl, output: (line) => lines.push(line), sleep: async () => {} };
  return { ssm, ddb, deps, lines };
}

describe('logs', () => {
  it('dumps the tail of every job with headers when several jobs match', async () => {
    const cwl = new FakeCwl(2);
    const { ddb, deps, lines } = fixture(cwl);
    ddb.put(TABLE, runItem());
    ddb.put(TABLE, jobItem('build'));
    ddb.put(TABLE, jobItem('test', { status: 'FAILED' }));
    cwl.append('stream/build', 'b1', 'b2', 'b3');
    cwl.append('stream/test', 'x1');
    await logs(deps, { run: 'ci#7' });
    expect(lines).toEqual([
      '=== build (SUCCEEDED) ===',
      'b2',
      'b3',
      '=== test (FAILED) ===',
      'x1',
    ]);
  });

  it('--full pages through the whole stream from the head', async () => {
    const cwl = new FakeCwl(2);
    const { ddb, deps, lines } = fixture(cwl);
    ddb.put(TABLE, runItem());
    ddb.put(TABLE, jobItem('build'));
    cwl.append('stream/build', 'b1', 'b2', 'b3', 'b4', 'b5');
    await logs(deps, { run: 'ci#7', job: 'build', full: true });
    expect(lines).toEqual(['b1', 'b2', 'b3', 'b4', 'b5']);
  });

  it('--failed narrows to failed jobs', async () => {
    const cwl = new FakeCwl();
    const { ddb, deps, lines } = fixture(cwl);
    ddb.put(TABLE, runItem());
    ddb.put(TABLE, jobItem('build'));
    ddb.put(TABLE, jobItem('test', { status: 'TIMED_OUT' }));
    cwl.append('stream/build', 'b1');
    cwl.append('stream/test', 'x1');
    await logs(deps, { run: 'ci#7', failed: true });
    expect(lines).toEqual(['x1']);
  });

  it('says so when --failed finds nothing', async () => {
    const cwl = new FakeCwl();
    const { ddb, deps, lines } = fixture(cwl);
    ddb.put(TABLE, runItem({ status: 'SUCCEEDED' }));
    ddb.put(TABLE, jobItem('build'));
    await logs(deps, { run: 'ci#7', failed: true });
    expect(lines).toEqual(['run ci#7 has no failed jobs']);
  });

  it('rejects an unknown --job naming the real ones', async () => {
    const cwl = new FakeCwl();
    const { ddb, deps } = fixture(cwl);
    ddb.put(TABLE, runItem());
    ddb.put(TABLE, jobItem('build'));
    await expect(logs(deps, { run: 'ci#7', job: 'nope' })).rejects.toThrow(/jobs: build/);
  });

  it('rejects -f with --full', async () => {
    const cwl = new FakeCwl();
    const { deps } = fixture(cwl);
    await expect(logs(deps, { follow: true, full: true })).rejects.toThrow(/tail or dump/);
  });

  it('-f polls for new events, picks up new jobs from the head, and stops at terminality', async () => {
    const cwl = new FakeCwl();
    const { ddb, deps, lines } = fixture(cwl);
    ddb.put(TABLE, runItem({ status: 'RUNNING' }));
    ddb.put(TABLE, jobItem('build', { status: 'RUNNING' }));
    cwl.append('stream/build', 'b1');

    let polls = 0;
    (deps as { sleep: (ms: number) => Promise<void> }).sleep = async () => {
      polls++;
      if (polls === 1) {
        cwl.append('stream/build', 'b2');
        ddb.put(TABLE, jobItem('test', { status: 'RUNNING' }));
        cwl.append('stream/test', 'x1');
      } else if (polls === 2) {
        ddb.put(TABLE, jobItem('build', { status: 'SUCCEEDED' }));
        ddb.put(TABLE, jobItem('test', { status: 'SUCCEEDED' }));
        ddb.put(TABLE, runItem({ status: 'SUCCEEDED' }));
      }
    };

    await logs(deps, { run: 'ci#7', follow: true });
    expect(lines).toEqual([
      'b1',
      '[build] b2',
      '[test] x1',
      '(run ci#7 succeeded — end of logs)',
    ]);
  });
});
