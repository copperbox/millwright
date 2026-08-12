import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  allocateLocalRun,
  findLocalRoot,
  isLocalRunId,
  listLocalRunNumbers,
  localLayout,
} from '../src/local/local-layout';
import { LocalStateSink, readLocalRunFile } from '../src/local/state-sink';

const tmpdirs: string[] = [];

function tmp(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'millwright-local-'));
  tmpdirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of tmpdirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe('local run allocation', () => {
  it('allocates local-1 first, then increments past the newest state file', () => {
    const layout = localLayout(tmp());
    expect(allocateLocalRun(layout).id).toBe('local-1');
    new LocalStateSink(path.join(layout.runsDir, 'local-1.json'), {
      id: 'local-1',
      repo: 'acme/api',
      workflow: 'ci',
      ref: 'refs/heads/main',
      sha: 'c0ffee00',
    });
    expect(allocateLocalRun(layout).id).toBe('local-2');
    expect(listLocalRunNumbers(layout)).toEqual([1]);
  });

  it('self-gitignores the .millwright directory', () => {
    const layout = localLayout(tmp());
    allocateLocalRun(layout);
    expect(fs.readFileSync(path.join(layout.millwrightDir, '.gitignore'), 'utf8')).toBe('*\n');
  });

  it('recognizes local run ids', () => {
    expect(isLocalRunId('local-3')).toBe(true);
    expect(isLocalRunId('local-0')).toBe(false);
    expect(isLocalRunId('ci#3')).toBe(false);
    expect(isLocalRunId('local-')).toBe(false);
  });

  it('finds the clone root from a nested cwd', () => {
    const root = tmp();
    fs.mkdirSync(path.join(root, '.git'));
    const nested = path.join(root, 'a', 'b');
    fs.mkdirSync(nested, { recursive: true });
    expect(findLocalRoot(nested)).toBe(root);
  });
});

describe('LocalStateSink', () => {
  it('round-trips run, job and step state through the file', () => {
    const stateFile = path.join(tmp(), 'runs', 'local-1.json');
    const sink = new LocalStateSink(stateFile, {
      id: 'local-1',
      repo: 'acme/api',
      workflow: 'ci',
      ref: 'refs/heads/main',
      sha: 'c0ffee00-dirty',
      inputs: { env: 'prod', dryRun: false },
    });
    sink.claimDispatch('build', 'millwright-local-1-build-1');
    sink.recordJobStarted('build');
    sink.putStep({ job: 'build', stepIndex: 0, status: 'RUNNING', startedAt: '2026-08-12T01:00:00Z' });
    sink.putStep({
      job: 'build',
      stepIndex: 0,
      status: 'SUCCEEDED',
      startedAt: '2026-08-12T01:00:00Z',
      finishedAt: '2026-08-12T01:00:30Z',
    });
    sink.recordJobFinished('build', 'SUCCEEDED', 0);
    sink.markJob('deploy', 'SKIPPED', 'upstream_failed');
    sink.finishRun('SUCCEEDED');
    sink.flush();

    const read = readLocalRunFile(stateFile);
    expect(read.id).toBe('local-1');
    expect(read.run.status).toBe('SUCCEEDED');
    expect(read.run.runNumber).toBe(1);
    expect(read.run.inputs).toEqual({ env: 'prod', dryRun: false });
    const build = read.jobs.find((job) => job.job === 'build');
    expect(build?.status).toBe('SUCCEEDED');
    expect(build?.attempts).toBe(1);
    expect(build?.exitCode).toBe(0);
    const deploy = read.jobs.find((job) => job.job === 'deploy');
    expect(deploy?.status).toBe('SKIPPED');
    expect(deploy?.skipReason).toBe('upstream_failed');
    expect(read.steps).toHaveLength(1);
    expect(read.steps[0].status).toBe('SUCCEEDED');
    expect(read.steps[0].finishedAt).toBe('2026-08-12T01:00:30Z');
  });

  it('projects decider job state from its rows', () => {
    const stateFile = path.join(tmp(), 'runs', 'local-1.json');
    const sink = new LocalStateSink(stateFile, {
      id: 'local-1',
      repo: 'acme/api',
      workflow: 'ci',
      ref: 'refs/heads/main',
      sha: 'c0ffee00',
    });
    expect(sink.deciderState('build')).toBeUndefined();
    sink.claimDispatch('build', 'container-1');
    const state = sink.deciderState('build');
    expect(state?.attempts).toBe(1);
    expect(state?.buildId).toBe('container-1');
    expect(state?.tableStatus).toBe('QUEUED');
    sink.seedReusedJob('lib', 'local-3');
    expect(sink.deciderState('lib')).toMatchObject({ tableStatus: 'SUCCEEDED', reusedFrom: 'local-3' });
  });

  it('a re-claim clears the previous attempt leftovers', () => {
    const stateFile = path.join(tmp(), 'runs', 'local-1.json');
    const sink = new LocalStateSink(stateFile, {
      id: 'local-1',
      repo: 'acme/api',
      workflow: 'ci',
      ref: 'refs/heads/main',
      sha: 'c0ffee00',
    });
    sink.claimDispatch('build', 'c1');
    sink.recordJobStarted('build');
    sink.recordJobFinished('build', 'FAILED', 9);
    sink.claimDispatch('build', 'c2');
    const row = sink.state.jobs.find((job) => job.job === 'build');
    expect(row?.attempts).toBe(2);
    expect(row?.container).toBe('c2');
    expect(row?.finishedAt).toBeUndefined();
    expect(row?.exitCode).toBeUndefined();
  });
});
