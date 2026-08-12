import { PutEventsCommand } from '@aws-sdk/client-eventbridge';
import { SendTaskSuccessCommand } from '@aws-sdk/client-sfn';
import { GetCommand, QueryCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb';
import {
  JobItem,
  JobStatus,
  RunCoordinates,
  RunItem,
  SkipReason,
  checkStateKey,
  jobKey,
  registryKey,
  runKey,
  stepKey,
} from '@copperbox/millwright-state';
import { describe, expect, it } from 'vitest';
import {
  AwsClientLike,
  RunsCommandError,
  RunsDeps,
  cancelRun,
  cloudWatchLogLink,
  rerunRun,
  resolveRunRef,
  runsList,
  runsShow,
} from '../src/runs';
import { FakeDdb } from './fake-ddb';
import { FakeSsm } from './fake-ssm';

const NOW = Date.parse('2026-08-12T06:00:00Z');
const COORDS: RunCoordinates = { repo: 'octocat/app', workflow: 'ci', runNumber: 41 };
const SHA = 'c'.repeat(40);

/** In-memory table speaking the three document commands the module sends. */
class FakeDynamo implements AwsClientLike {
  readonly runs = new Map<string, RunItem>();
  readonly jobs: JobItem[] = [];

  putRun(coords: RunCoordinates, overrides: Partial<RunItem> = {}): void {
    const key = runKey(coords);
    this.runs.set(key.pk + key.sk, {
      ...key,
      ...coords,
      status: 'FAILED',
      trigger: 'push',
      ref: 'refs/heads/main',
      sha: SHA,
      createdAt: new Date(NOW).toISOString(),
      originalStartedAt: new Date(NOW).toISOString(),
      expiresAt: 0,
      ...overrides,
    });
  }

  putJob(job: string, status: JobStatus, skipReason?: SkipReason): void {
    this.jobs.push({
      ...jobKey(COORDS, job),
      ...COORDS,
      job,
      status,
      ...(skipReason ? { skipReason } : {}),
      expiresAt: 0,
    });
  }

  async send(command: unknown): Promise<any> {
    if (command instanceof UpdateCommand) {
      const { Key } = command.input;
      const stored = this.runs.get((Key!.pk as string) + (Key!.sk as string));
      if (!stored) {
        throw Object.assign(new Error('conditional check failed'), {
          name: 'ConditionalCheckFailedException',
        });
      }
      const updated = { ...stored, cancelRequested: true };
      this.runs.set((Key!.pk as string) + (Key!.sk as string), updated);
      return { Attributes: updated };
    }
    if (command instanceof GetCommand) {
      const { Key } = command.input;
      return { Item: this.runs.get((Key!.pk as string) + (Key!.sk as string)) };
    }
    if (command instanceof QueryCommand) {
      return { Items: [...this.jobs] };
    }
    throw new Error('unexpected command');
  }
}

class FakeSfn implements AwsClientLike {
  readonly sent: { taskToken: string; output: string }[] = [];
  failWith?: string;

  async send(command: unknown): Promise<any> {
    if (!(command instanceof SendTaskSuccessCommand)) {
      throw new Error('unexpected command');
    }
    if (this.failWith) {
      throw Object.assign(new Error(this.failWith), { name: this.failWith });
    }
    this.sent.push(command.input as { taskToken: string; output: string });
    return {};
  }
}

class FakeEvents implements AwsClientLike {
  readonly entries: Record<string, unknown>[] = [];
  failedEntryCount = 0;

  async send(command: unknown): Promise<any> {
    if (!(command instanceof PutEventsCommand)) {
      throw new Error('unexpected command');
    }
    this.entries.push(...(command.input.Entries as Record<string, unknown>[]));
    if (this.failedEntryCount > 0) {
      return {
        FailedEntryCount: this.failedEntryCount,
        Entries: [{ ErrorCode: 'AccessDenied', ErrorMessage: 'nope' }],
      };
    }
    return { FailedEntryCount: 0 };
  }
}

describe('resolveRunRef', () => {
  it('parses full and repo-scoped references', () => {
    expect(resolveRunRef('octocat/app#ci#41')).toEqual(COORDS);
    expect(resolveRunRef('ci#41', 'octocat/app')).toEqual(COORDS);
  });

  it('demands --repo for a repo-scoped reference and rejects garbage', () => {
    expect(() => resolveRunRef('ci#41')).toThrow(/--repo/);
    expect(() => resolveRunRef('ci')).toThrow(RunsCommandError);
    expect(() => resolveRunRef('ci#not-a-number', 'octocat/app')).toThrow(RunsCommandError);
  });
});

describe('cancelRun (spec §7.6)', () => {
  it('writes cancelRequested and completes the current task token', async () => {
    const dynamo = new FakeDynamo();
    const sfn = new FakeSfn();
    dynamo.putRun(COORDS, { status: 'RUNNING', taskToken: 'tok-7' });

    const result = await cancelRun({ dynamo, sfn, tableName: 't' }, COORDS);
    expect(result).toEqual({
      runId: 'octocat/app#ci#41',
      status: 'RUNNING',
      requested: true,
      woke: true,
    });
    const key = runKey(COORDS);
    expect(dynamo.runs.get(key.pk + key.sk)?.cancelRequested).toBe(true);
    expect(sfn.sent).toEqual([{ taskToken: 'tok-7', output: JSON.stringify({ outcome: 'wake' }) }]);
  });

  it('swallows a stale token — the decider converges on its own timeout', async () => {
    const dynamo = new FakeDynamo();
    const sfn = new FakeSfn();
    sfn.failWith = 'TaskTimedOut';
    dynamo.putRun(COORDS, { status: 'RUNNING', taskToken: 'tok-stale' });

    const result = await cancelRun({ dynamo, sfn, tableName: 't' }, COORDS);
    expect(result.requested).toBe(true);
    expect(result.woke).toBe(false);
    const key = runKey(COORDS);
    expect(dynamo.runs.get(key.pk + key.sk)?.cancelRequested).toBe(true);
  });

  it('rethrows non-stale token failures', async () => {
    const dynamo = new FakeDynamo();
    const sfn = new FakeSfn();
    sfn.failWith = 'AccessDeniedException';
    dynamo.putRun(COORDS, { status: 'RUNNING', taskToken: 'tok' });
    await expect(cancelRun({ dynamo, sfn, tableName: 't' }, COORDS)).rejects.toThrow(
      'AccessDeniedException',
    );
  });

  it('flags a queued run without a token; the first decider entry cancels it', async () => {
    const dynamo = new FakeDynamo();
    const sfn = new FakeSfn();
    dynamo.putRun(COORDS, { status: 'QUEUED' });

    const result = await cancelRun({ dynamo, sfn, tableName: 't' }, COORDS);
    expect(result).toMatchObject({ status: 'QUEUED', requested: true, woke: false });
    expect(sfn.sent).toEqual([]);
  });

  it('reports an already-terminal run instead of pretending to cancel', async () => {
    const dynamo = new FakeDynamo();
    const sfn = new FakeSfn();
    dynamo.putRun(COORDS, { status: 'SUCCEEDED' });

    const result = await cancelRun({ dynamo, sfn, tableName: 't' }, COORDS);
    expect(result).toMatchObject({ status: 'SUCCEEDED', requested: false });
    expect(sfn.sent).toEqual([]);
  });

  it('fails loudly when the run does not exist', async () => {
    await expect(
      cancelRun({ dynamo: new FakeDynamo(), sfn: new FakeSfn(), tableName: 't' }, COORDS),
    ).rejects.toThrow(/No run octocat\/app#ci#41/);
  });
});

describe('rerunRun (spec §7.7)', () => {
  function deps(dynamo: FakeDynamo, events: FakeEvents) {
    return { dynamo, events, tableName: 't', busName: 'mw-bus', nonce: () => 'nonce-1' };
  }

  it('emits the rerun event from the stored run record', async () => {
    const dynamo = new FakeDynamo();
    const events = new FakeEvents();
    dynamo.putRun(COORDS, { status: 'FAILED', ref: 'refs/tags/v1', sha: 'e'.repeat(40) });

    const result = await rerunRun(deps(dynamo, events), COORDS, { failed: false });
    expect(result).toEqual({ sourceRunId: 'octocat/app#ci#41', failedOnly: false, nonce: 'nonce-1' });
    expect(events.entries).toHaveLength(1);
    expect(events.entries[0]).toMatchObject({
      EventBusName: 'mw-bus',
      Source: 'millwright.cli',
      DetailType: 'rerun',
    });
    expect(JSON.parse(events.entries[0].Detail as string)).toEqual({
      repo: 'octocat/app',
      ref: 'refs/tags/v1',
      sha: 'e'.repeat(40),
      kind: 'rerun',
      workflow: 'ci',
      sourceRunNumber: 41,
      failedOnly: false,
      nonce: 'nonce-1',
    });
  });

  it('--failed passes when something failed and rejects when nothing did', async () => {
    const dynamo = new FakeDynamo();
    const events = new FakeEvents();
    dynamo.putRun(COORDS, { status: 'FAILED' });
    dynamo.putJob('build', 'SUCCEEDED');
    dynamo.putJob('test', 'TIMED_OUT');

    const result = await rerunRun(deps(dynamo, events), COORDS, { failed: true });
    expect(result.failedOnly).toBe(true);
    expect(JSON.parse(events.entries[0].Detail as string).failedOnly).toBe(true);

    const clean = new FakeDynamo();
    clean.putRun(COORDS, { status: 'SUCCEEDED' });
    clean.putJob('build', 'SUCCEEDED');
    clean.putJob('guard', 'SKIPPED', 'skip_if');
    await expect(
      rerunRun(deps(clean, new FakeEvents()), COORDS, { failed: true }),
    ).rejects.toThrow(/Nothing failed/);
  });

  it('rejects missing and non-terminal source runs', async () => {
    await expect(
      rerunRun(deps(new FakeDynamo(), new FakeEvents()), COORDS, { failed: false }),
    ).rejects.toThrow(/No run/);

    const running = new FakeDynamo();
    running.putRun(COORDS, { status: 'RUNNING' });
    await expect(
      rerunRun(deps(running, new FakeEvents()), COORDS, { failed: false }),
    ).rejects.toThrow(/RUNNING/);
  });

  it('surfaces a bus rejection instead of reporting success', async () => {
    const dynamo = new FakeDynamo();
    const events = new FakeEvents();
    events.failedEntryCount = 1;
    dynamo.putRun(COORDS, { status: 'CANCELLED' });
    await expect(rerunRun(deps(dynamo, events), COORDS, { failed: false })).rejects.toThrow(
      /AccessDenied/,
    );
  });
});

const TABLE = 'millwright-prod-state';
const LOG_GROUP = '/millwright/prod/builds';
const READ_SHA = 'c0ffee0000000000000000000000000000000000';

function registryItem(repo: string, ref: string, workflows: string[]) {
  return {
    ...registryKey(repo, ref),
    repo,
    ref,
    schemaVersion: 1,
    workflows: Object.fromEntries(workflows.map((w) => [w, { triggers: {} }])),
  };
}

function runItem(
  repo: string,
  workflow: string,
  runNumber: number,
  overrides: Partial<RunItem> = {},
): any {
  return {
    ...runKey({ repo, workflow, runNumber }),
    repo,
    workflow,
    runNumber,
    status: 'SUCCEEDED',
    trigger: 'push',
    ref: 'refs/heads/main',
    sha: READ_SHA,
    createdAt: `2026-08-12T0${runNumber}:00:00Z`,
    startedAt: `2026-08-12T0${runNumber}:00:05Z`,
    finishedAt: `2026-08-12T0${runNumber}:04:16Z`,
    originalStartedAt: `2026-08-12T0${runNumber}:00:05Z`,
    expiresAt: 1790000000,
    ...overrides,
  };
}

function fixture() {
  const ssm = new FakeSsm();
  ssm.setManifest('prod', { stateTable: TABLE, buildLogGroup: LOG_GROUP });
  ssm.set('/millwright/prod/repos/acme/api/config', '{}');
  const ddb = new FakeDdb();
  ddb.put(TABLE, registryItem('acme/api', 'refs/heads/main', ['ci']));
  const lines: string[] = [];
  const deps: RunsDeps = {
    ssm,
    ddb,
    output: (line) => lines.push(line),
    region: 'eu-west-1',
    now: () => new Date('2026-08-12T09:00:00Z'),
  };
  return { ssm, ddb, deps, lines };
}

describe('runs list', () => {
  it('lists newest-first with ci#N identifiers', async () => {
    const { ddb, deps, lines } = fixture();
    ddb.put(TABLE, runItem('acme/api', 'ci', 1));
    ddb.put(TABLE, runItem('acme/api', 'ci', 2, { status: 'FAILED' }));
    const shown = await runsList(deps, {});
    expect(shown.map((run) => run.runNumber)).toEqual([2, 1]);
    expect(lines[0]).toMatch(/^RUN\s+REPO\s+STATUS\s+TRIGGER\s+REF\s+SHA\s+CREATED\s+DURATION$/);
    expect(lines[1]).toMatch(/^ci#2\s+acme\/api\s+FAILED\s+push\s+main\s+c0ffee00\s+2026-08-12T02:00:00Z\s+4m11s$/);
  });

  it('filters by ref (short or full) and status', async () => {
    const { ddb, deps } = fixture();
    ddb.put(TABLE, runItem('acme/api', 'ci', 1, { ref: 'refs/heads/dev' }));
    ddb.put(TABLE, runItem('acme/api', 'ci', 2));
    ddb.put(TABLE, runItem('acme/api', 'ci', 3, { status: 'RUNNING', finishedAt: undefined }));
    expect((await runsList(deps, { ref: 'dev' })).map((r) => r.runNumber)).toEqual([1]);
    expect((await runsList(deps, { ref: 'refs/heads/dev' })).map((r) => r.runNumber)).toEqual([1]);
    expect((await runsList(deps, { status: 'running' })).map((r) => r.runNumber)).toEqual([3]);
  });

  it('filters by workflow and marks superseded runs', async () => {
    const { ddb, deps, lines } = fixture();
    ddb.put(TABLE, registryItem('acme/api', 'refs/heads/main', ['ci', 'nightly']));
    ddb.put(TABLE, runItem('acme/api', 'nightly', 1, { status: 'CANCELLED', reason: 'superseded' }));
    ddb.put(TABLE, runItem('acme/api', 'ci', 2));
    const shown = await runsList(deps, { workflow: 'nightly' });
    expect(shown.map((run) => run.workflow)).toEqual(['nightly']);
    expect(lines.join('\n')).toContain('CANCELLED (superseded)');
  });

  it('prints a plain line when nothing matches', async () => {
    const { deps, lines } = fixture();
    await runsList(deps, {});
    expect(lines).toEqual(['No runs found.']);
  });
});

describe('runs show', () => {
  it('renders jobs, steps, reuse, skip reasons, and a CloudWatch link', async () => {
    const { ddb, deps, lines } = fixture();
    ddb.put(TABLE, runItem('acme/api', 'ci', 7, { status: 'FAILED' }));
    const coords = { repo: 'acme/api', workflow: 'ci', runNumber: 7 };
    ddb.put(TABLE, {
      ...jobKey(coords, 'build'),
      ...coords,
      job: 'build',
      status: 'SUCCEEDED',
      startedAt: '2026-08-12T07:00:10Z',
      finishedAt: '2026-08-12T07:02:13Z',
      logStreamName: 'stream/build-1',
      expiresAt: 1790000000,
    });
    ddb.put(TABLE, {
      ...jobKey(coords, 'test'),
      ...coords,
      job: 'test',
      status: 'FAILED',
      startedAt: '2026-08-12T07:02:20Z',
      finishedAt: '2026-08-12T07:03:00Z',
      expiresAt: 1790000000,
    });
    ddb.put(TABLE, {
      ...jobKey(coords, 'deploy'),
      ...coords,
      job: 'deploy',
      status: 'SKIPPED',
      skipReason: 'upstream_failed',
      expiresAt: 1790000000,
    });
    ddb.put(TABLE, {
      ...jobKey(coords, 'lint'),
      ...coords,
      job: 'lint',
      status: 'SUCCEEDED',
      reusedFrom: 'ci#5',
      expiresAt: 1790000000,
    });
    ddb.put(TABLE, {
      ...stepKey(coords, 'build', 0),
      ...coords,
      job: 'build',
      stepIndex: 0,
      status: 'SUCCEEDED',
      name: 'install',
      startedAt: '2026-08-12T07:00:10Z',
      finishedAt: '2026-08-12T07:00:40Z',
      expiresAt: 1790000000,
    });
    ddb.put(TABLE, {
      ...checkStateKey('acme/api', READ_SHA, 'millwright / test'),
      repo: 'acme/api',
      sha: READ_SHA,
      context: 'millwright / test',
      abandoned: true,
      backoffAttempts: 6,
      expiresAt: 1790000000,
    });

    await runsShow(deps, { run: 'ci#7' });
    const text = lines.join('\n');
    expect(lines[0]).toBe('acme/api/ci#7  FAILED');
    expect(text).toContain('trigger push  main @ c0ffee00');
    expect(text).toContain('build  SUCCEEDED  2m03s');
    expect(text).toContain('1. install  SUCCEEDED  30s');
    expect(text).toContain('test  FAILED  40s');
    expect(text).toContain('deploy  SKIPPED  (upstream failed)');
    expect(text).toContain('lint  SUCCEEDED  (reused from ci#5)');
    expect(text).toContain(cloudWatchLogLink('eu-west-1', LOG_GROUP, 'stream/build-1'));
    expect(text).toContain('check "millwright / test" abandoned — reporting to GitHub gave up after 6 attempts');
  });

  it('shows the superseded reason and rerun lineage', async () => {
    const { ddb, deps, lines } = fixture();
    ddb.put(
      TABLE,
      runItem('acme/api', 'ci', 3, { status: 'CANCELLED', reason: 'superseded', rerunOf: 'ci#1' }),
    );
    await runsShow(deps, {});
    expect(lines[0]).toBe('acme/api/ci#3  CANCELLED  (superseded)');
    expect(lines.join('\n')).toContain('rerun of ci#1');
  });
});

describe('cloudWatchLogLink', () => {
  it('escapes the group and stream the way the console expects', () => {
    expect(cloudWatchLogLink('us-east-1', '/millwright/prod/builds', 'a/b:c')).toBe(
      'https://us-east-1.console.aws.amazon.com/cloudwatch/home?region=us-east-1' +
        '#logsV2:log-groups/log-group/$252Fmillwright$252Fprod$252Fbuilds/log-events/a$252Fb$253Ac',
    );
  });
});
