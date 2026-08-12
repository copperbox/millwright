import { PutEventsCommand } from '@aws-sdk/client-eventbridge';
import { SendTaskSuccessCommand } from '@aws-sdk/client-sfn';
import { GetCommand, QueryCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb';
import {
  JobItem,
  JobStatus,
  RunCoordinates,
  RunItem,
  SkipReason,
  jobKey,
  runKey,
} from '@copperbox/millwright-state';
import { describe, expect, it } from 'vitest';
import {
  AwsClientLike,
  RunsCommandError,
  cancelRun,
  manifestResource,
  rerunRun,
  resolveRunRef,
} from '../src/runs';

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

describe('manifestResource', () => {
  const deployment = {
    name: 'mw',
    manifestParameterName: '/millwright/mw/manifest',
    manifest: {
      deploymentName: 'mw',
      version: '0.1.0',
      schemaVersion: 1,
      resources: { stateTable: 'mw-state', eventBus: 'mw-bus' },
    },
  };

  it('returns physical names and fails loudly on old manifests', () => {
    expect(manifestResource(deployment, 'stateTable')).toBe('mw-state');
    expect(() => manifestResource(deployment, 'pollerQueue')).toThrow(/pollerQueue/);
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
