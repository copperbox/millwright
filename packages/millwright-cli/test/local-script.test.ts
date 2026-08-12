import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { RenderedBuildspec } from '@copperbox/millwright-state';
import { afterEach, describe, expect, it } from 'vitest';
import { renderLocalScript } from '../src/local/local-script';

const tmpdirs: string[] = [];

afterEach(() => {
  for (const dir of tmpdirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

/** Run the generated script with the system POSIX shell, capturing a log. */
function runScript(buildspec: RenderedBuildspec): { exitCode: number; log: string[] } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'millwright-script-'));
  tmpdirs.push(dir);
  const scriptFile = path.join(dir, 'job.sh');
  fs.writeFileSync(scriptFile, renderLocalScript(buildspec));
  const logFile = path.join(dir, 'log');
  fs.writeFileSync(logFile, '');
  let exitCode = 0;
  try {
    execFileSync('/bin/sh', [scriptFile], { env: { ...process.env, MW_LOG: logFile } });
  } catch (err) {
    exitCode = (err as { status?: number }).status ?? 1;
  }
  return { exitCode, log: fs.readFileSync(logFile, 'utf8').split('\n').filter(Boolean) };
}

function spec(phases: {
  install?: string[];
  preBuild?: string[];
  build: string[];
  postBuild?: string[];
}): RenderedBuildspec {
  return {
    version: '0.2',
    env: { shell: '/bin/sh' },
    phases: {
      ...(phases.install ? { install: { commands: phases.install } } : {}),
      pre_build: { commands: phases.preBuild ?? [] },
      build: { commands: phases.build },
      ...(phases.postBuild ? { post_build: { commands: phases.postBuild } } : {}),
    },
  };
}

const log = (tag: string) => `echo ${tag} >> "$MW_LOG"`;
const logFlag = (tag: string) => `echo ${tag}=$CODEBUILD_BUILD_SUCCEEDING >> "$MW_LOG"`;

describe('renderLocalScript', () => {
  it('runs all phases in order and exits 0 on success', () => {
    const { exitCode, log: lines } = runScript(
      spec({
        install: [log('install')],
        preBuild: [log('pre')],
        build: [log('build1'), log('build2')],
        postBuild: [logFlag('post')],
      }),
    );
    expect(exitCode).toBe(0);
    expect(lines).toEqual(['install', 'pre', 'build1', 'build2', 'post=1']);
  });

  it('a failing build command skips the rest of the phase but still runs post_build with the flag down', () => {
    const { exitCode, log: lines } = runScript(
      spec({
        build: [log('build1'), 'exit 3', log('never')],
        postBuild: [logFlag('post')],
      }),
    );
    // CodeBuild parity: the build failure decides the job's exit code even
    // though post_build ran.
    expect(exitCode).toBe(3);
    expect(lines).toEqual(['build1', 'post=0']);
  });

  it('a failing pre_build command fails the job on the spot — no build, no post_build', () => {
    const { exitCode, log: lines } = runScript(
      spec({
        preBuild: [log('pre'), 'false'],
        build: [log('build')],
        postBuild: [log('post')],
      }),
    );
    expect(exitCode).toBe(1);
    expect(lines).toEqual(['pre']);
  });

  it('a failing install command fails the job before pre_build', () => {
    const { exitCode, log: lines } = runScript(
      spec({
        install: ['exit 7'],
        preBuild: [log('pre')],
        build: [log('build')],
      }),
    );
    expect(exitCode).toBe(7);
    expect(lines).toEqual([]);
  });

  it('a post_build failure fails an otherwise green job', () => {
    const { exitCode, log: lines } = runScript(
      spec({
        build: [log('build')],
        postBuild: ['exit 5', log('after')],
      }),
    );
    expect(exitCode).toBe(5);
    // post_build keeps going after a failure, like CodeBuild.
    expect(lines).toEqual(['build', 'after']);
  });

  it('compound one-line commands behave as single buildspec commands', () => {
    const { exitCode, log: lines } = runScript(
      spec({
        build: [`${log('a')} && false`, log('after-failure')],
        postBuild: [logFlag('post')],
      }),
    );
    expect(exitCode).toBe(1);
    expect(lines).toEqual(['a', 'post=0']);
  });
});
