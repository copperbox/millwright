import {
  BuildMappingItem,
  JobItem,
  RunCoordinates,
  RunItem,
  buildMappingKey,
  jobKey,
  runKey,
} from '@copperbox/millwright-state';
import { describe, expect, it } from 'vitest';
import {
  BuildEventsDeps,
  BuildEventsStore,
  CodeBuildStateChangeEvent,
  WakeSender,
  buildIdFromArn,
  processBuildStateChange,
} from '../src/runtime/build-events/build-events';
import { JobProjectionPatch } from '../src/runtime/shared/jobs';

const NOW = Date.parse('2026-08-12T06:00:00Z');
const COORDS: RunCoordinates = { repo: 'octo/app', workflow: 'ci', runNumber: 7 };
const BUILD_ID = 'mw-builds:11111111-2222-3333-4444-555555555555';
const BUILD_ARN = `arn:aws:codebuild:eu-west-1:123456789012:build/${BUILD_ID}`;

class MemoryStore implements BuildEventsStore {
  readonly mappings = new Map<string, BuildMappingItem>();
  readonly jobs = new Map<string, JobItem>();
  readonly runs = new Map<string, RunItem>();
  readonly ttlStamps: string[] = [];

  seedMapping(buildId = BUILD_ID): void {
    this.mappings.set(buildId, { ...buildMappingKey(buildId), ...COORDS, job: 'build' });
  }

  seedJob(overrides: Partial<JobItem> = {}): void {
    const key = jobKey(COORDS, 'build');
    this.jobs.set(key.pk + key.sk, {
      ...key,
      ...COORDS,
      job: 'build',
      status: 'RUNNING',
      buildId: BUILD_ID,
      attempts: 1,
      expiresAt: 0,
      ...overrides,
    });
  }

  seedRun(overrides: Partial<RunItem> = {}): void {
    const key = runKey(COORDS);
    this.runs.set(key.pk + key.sk, {
      ...key,
      ...COORDS,
      status: 'RUNNING',
      trigger: 'push',
      ref: 'refs/heads/main',
      sha: 'a'.repeat(40),
      createdAt: new Date(NOW).toISOString(),
      originalStartedAt: new Date(NOW).toISOString(),
      taskToken: 'token-live',
      expiresAt: 0,
      ...overrides,
    });
  }

  async getBuildMapping(buildId: string): Promise<BuildMappingItem | undefined> {
    return this.mappings.get(buildId);
  }

  async writeJobProjection(
    coords: RunCoordinates,
    job: string,
    patch: JobProjectionPatch,
    _nowMs: number,
  ): Promise<void> {
    const key = jobKey(coords, job);
    const row = this.jobs.get(key.pk + key.sk);
    if (patch.ifBuildId !== undefined && row?.buildId !== patch.ifBuildId) {
      return; // conditional check failed — swallowed like the Dynamo store
    }
    this.jobs.set(key.pk + key.sk, {
      ...(row ?? { ...key, ...coords, job, status: patch.status, expiresAt: 0 }),
      status: patch.status,
      ...(patch.logStreamName !== undefined ? { logStreamName: patch.logStreamName } : {}),
      ...(patch.finishedAt !== undefined ? { finishedAt: patch.finishedAt } : {}),
    });
  }

  async stampBuildMappingTtl(buildId: string, _nowMs: number): Promise<void> {
    this.ttlStamps.push(buildId);
  }

  async getRun(coords: RunCoordinates): Promise<RunItem | undefined> {
    const key = runKey(coords);
    return this.runs.get(key.pk + key.sk);
  }

  job(): JobItem | undefined {
    const key = jobKey(COORDS, 'build');
    return this.jobs.get(key.pk + key.sk);
  }
}

class FakeSender implements WakeSender {
  readonly wakes: string[] = [];
  stale = false;

  async wake(taskToken: string): Promise<'sent' | 'stale'> {
    this.wakes.push(taskToken);
    return this.stale ? 'stale' : 'sent';
  }
}

function harness() {
  const store = new MemoryStore();
  const sender = new FakeSender();
  const deps: BuildEventsDeps = { store, sender, log: () => {} };
  return { store, sender, deps };
}

function event(buildStatus: string, buildArn: string = BUILD_ARN): CodeBuildStateChangeEvent {
  return {
    source: 'aws.codebuild',
    'detail-type': 'CodeBuild Build State Change',
    detail: {
      'build-status': buildStatus,
      'build-id': buildArn,
      'project-name': 'mw-builds',
      'additional-information': { logs: { 'stream-name': 'stream-1' } },
    },
  };
}

describe('buildIdFromArn', () => {
  it('extracts the project-qualified build id from the event ARN', () => {
    expect(buildIdFromArn(BUILD_ARN)).toBe(BUILD_ID);
    expect(buildIdFromArn('not-an-arn')).toBeUndefined();
    expect(buildIdFromArn('arn:aws:codebuild:eu-west-1:1:build/')).toBeUndefined();
  });
});

describe('processBuildStateChange', () => {
  it('updates the job row via the BUILD# lookup and wakes the run token', async () => {
    const { store, sender, deps } = harness();
    store.seedMapping();
    store.seedJob();
    store.seedRun();

    expect(await processBuildStateChange(deps, event('SUCCEEDED'), NOW)).toBe('woke');
    expect(store.job()).toMatchObject({
      status: 'SUCCEEDED',
      logStreamName: 'stream-1',
      finishedAt: new Date(NOW).toISOString(),
    });
    expect(sender.wakes).toEqual(['token-live']);
    expect(store.ttlStamps).toEqual([BUILD_ID]);
  });

  it('swallows a stale token without error', async () => {
    const { store, sender, deps } = harness();
    store.seedMapping();
    store.seedJob();
    store.seedRun();
    sender.stale = true;

    expect(await processBuildStateChange(deps, event('FAILED'), NOW)).toBe('stale-token');
    expect(store.job()).toMatchObject({ status: 'FAILED' });
  });

  it('ignores builds with no mapping (foreign or aged-out)', async () => {
    const { store, sender, deps } = harness();
    store.seedJob();
    store.seedRun();

    expect(await processBuildStateChange(deps, event('SUCCEEDED'), NOW)).toBe('unmapped');
    expect(store.job()?.status).toBe('RUNNING');
    expect(sender.wakes).toEqual([]);
  });

  it('ignores events without a build id', async () => {
    const { deps } = harness();
    expect(await processBuildStateChange(deps, { detail: {} }, NOW)).toBe('ignored');
  });

  it('still wakes when the row already shows a newer attempt, without clobbering it', async () => {
    const { store, sender, deps } = harness();
    store.seedMapping();
    store.seedJob({ buildId: 'mw-builds:newer-attempt', status: 'QUEUED' });
    store.seedRun();

    expect(await processBuildStateChange(deps, event('FAILED'), NOW)).toBe('woke');
    expect(store.job()?.status).toBe('QUEUED'); // fence held
    expect(sender.wakes).toEqual(['token-live']);
  });

  it('reports no-token between token generations; the timeout path covers it', async () => {
    const { store, sender, deps } = harness();
    store.seedMapping();
    store.seedJob();
    store.seedRun({ taskToken: undefined });

    expect(await processBuildStateChange(deps, event('SUCCEEDED'), NOW)).toBe('no-token');
    expect(sender.wakes).toEqual([]);
    expect(store.job()).toMatchObject({ status: 'SUCCEEDED' });
  });

  it('marks IN_PROGRESS as RUNNING without a finish time or TTL stamp', async () => {
    const { store, deps } = harness();
    store.seedMapping();
    store.seedJob({ status: 'QUEUED' });
    store.seedRun();

    expect(await processBuildStateChange(deps, event('IN_PROGRESS'), NOW)).toBe('woke');
    expect(store.job()).toMatchObject({ status: 'RUNNING' });
    expect(store.job()?.finishedAt).toBeUndefined();
    expect(store.ttlStamps).toEqual([]);
  });

  it('leaves FAULT projection to the decider but stamps TTL and wakes', async () => {
    const { store, sender, deps } = harness();
    store.seedMapping();
    store.seedJob();
    store.seedRun();

    expect(await processBuildStateChange(deps, event('FAULT'), NOW)).toBe('woke');
    expect(store.job()?.status).toBe('RUNNING'); // untouched — retry is the decider's call
    expect(store.ttlStamps).toEqual([BUILD_ID]);
    expect(sender.wakes).toEqual(['token-live']);
  });

  it('maps STOPPED to CANCELLED', async () => {
    const { store, deps } = harness();
    store.seedMapping();
    store.seedJob();
    store.seedRun();

    await processBuildStateChange(deps, event('STOPPED'), NOW);
    expect(store.job()).toMatchObject({ status: 'CANCELLED' });
  });
});
