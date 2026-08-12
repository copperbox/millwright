import {
  RunItem,
  checkStateKey,
  jobKey,
  registryKey,
  runKey,
  stepKey,
} from '@copperbox/millwright-state';
import { describe, expect, it } from 'vitest';
import { RunsDeps, cloudWatchLogLink, runsList, runsShow } from '../src/runs';
import { FakeDdb } from './fake-ddb';
import { FakeSsm } from './fake-ssm';

const TABLE = 'millwright-prod-state';
const LOG_GROUP = '/millwright/prod/builds';
const SHA = 'c0ffee0000000000000000000000000000000000';

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
    sha: SHA,
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
      ...checkStateKey('acme/api', SHA, 'millwright / test'),
      repo: 'acme/api',
      sha: SHA,
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
