import { validateRunModel } from '@copperbox/millwright-workflows';
import { execFileSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, describe, expect, it } from 'vitest';
import { repoFromRemoteUrl, runSynthCommand } from '../src/synth-command';

const DEFINITION = `
import { Artifact, Secret, Step, Trigger, Workflow, WorkflowSet } from '@copperbox/millwright-workflows';

const app = new WorkflowSet({ image: 'public.ecr.aws/docker/library/node:22' });

const ci = new Workflow(app, 'ci', {
  on: [Trigger.push({ branches: ['main'] }), Trigger.pullRequest()],
});
const build = ci.job('build', {
  steps: ['npm ci', 'npm test'],
  produces: { dist: Artifact.dir('dist') },
});
ci.job('integration', {
  consumes: { dist: build.artifacts.dist },
  steps: [Step.run('npm run test:integration', { skipIf: 'test -f skip-marker' })],
});

const release = new Workflow(app, 'release', {
  on: [Trigger.tag({ pattern: 'v*' })],
  concurrency: { group: 'release-\${repo}', policy: 'queue' },
});
release.job('publish', {
  secrets: { NPM_TOKEN: Secret.named('npm-token') },
  steps: ['npm publish'],
});

export default app;
`;

const tmpdirs: string[] = [];

function fixture(definition = DEFINITION, entry = path.join('millwright', 'workflows.ts')): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'millwright-synth-'));
  tmpdirs.push(dir);
  fs.mkdirSync(path.dirname(path.join(dir, entry)), { recursive: true });
  fs.writeFileSync(path.join(dir, entry), definition);
  return dir;
}

interface Run {
  code: number;
  stdout: string;
  stderr: string;
}

function run(cwd: string, options: Record<string, unknown> = {}): Run {
  let stdout = '';
  let stderr = '';
  const code = runSynthCommand({
    cwd,
    repo: 'copperbox/example',
    commit: 'deadbeef',
    ...options,
    stdout: (text: string) => (stdout += text),
    stderr: (text: string) => (stderr += text),
  });
  return { code, stdout, stderr };
}

afterEach(() => {
  for (const dir of tmpdirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe('millwright synth', () => {
  it('compiles a TypeScript definition to a schema-valid run model on stdout', () => {
    const result = run(fixture());
    expect(result.code).toBe(0);
    const model = JSON.parse(result.stdout);
    expect(validateRunModel(model)).toEqual({ ok: true, issues: [] });
    expect(model.repo).toBe('copperbox/example');
    expect(model.commit).toBe('deadbeef');
    expect(model.workflows.map((w: { name: string }) => w.name)).toEqual(['ci', 'release']);
    expect(model.workflows[0].jobs[1].steps[0]).toEqual({
      run: 'npm run test:integration',
      skipIf: 'test -f skip-marker',
    });
    // The definition declared secrets, so the masking lint lands on stderr.
    expect(result.stderr).toContain('secret-masking-exact-match');
  });

  it('loads the definition without the repo having installed anything', () => {
    const dir = fixture();
    expect(fs.existsSync(path.join(dir, 'node_modules'))).toBe(false);
    expect(run(dir).code).toBe(0);
  });

  it('writes to --out and stays quiet on stdout', () => {
    const dir = fixture();
    const result = run(dir, { out: 'model.json', pretty: true });
    expect(result.code).toBe(0);
    expect(result.stdout).toBe('');
    const model = JSON.parse(fs.readFileSync(path.join(dir, 'model.json'), 'utf8'));
    expect(validateRunModel(model).ok).toBe(true);
  });

  it('honors --entry for definitions living elsewhere', () => {
    const dir = fixture(DEFINITION, path.join('ci', 'defs.ts'));
    expect(run(dir, { entry: 'ci/defs.ts' }).code).toBe(0);
  });

  it('fails with the synth diagnostics when the definition has errors', () => {
    const broken = DEFINITION.replace(
      "new WorkflowSet({ image: 'public.ecr.aws/docker/library/node:22' })",
      'new WorkflowSet()',
    );
    const result = run(fixture(broken));
    expect(result.code).toBe(1);
    expect(result.stdout).toBe('');
    expect(result.stderr).toContain('error[image-unresolved]');
    expect(result.stderr).toContain('no run model emitted');
  });

  it('surfaces schema skew as a loud failure', () => {
    const result = run(fixture(), { schemaCeiling: 0 });
    expect(result.code).toBe(1);
    expect(result.stderr).toContain('error[schema-version-skew]');
  });

  it('emits the cron and secrets-ref lints when deployment context is passed', () => {
    const withCron = DEFINITION.replace(
      "on: [Trigger.tag({ pattern: 'v*' })]",
      "on: [Trigger.tag({ pattern: 'v*' }), Trigger.cron('*/2 * * * *')]",
    );
    const result = run(fixture(withCron), {
      pollCadence: 5,
      ref: 'feature/x',
      secretsAllowedRefs: ['main'],
    });
    expect(result.code).toBe(0);
    expect(result.stderr).toContain('cron-finer-than-poll-cadence');
    expect(result.stderr).toContain('secrets-ref-not-allowed');
  });

  it('fails clearly when the entry file is missing', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'millwright-empty-'));
    tmpdirs.push(dir);
    const result = run(dir);
    expect(result.code).toBe(1);
    expect(result.stderr).toContain('No workflow definition at');
  });

  it('fails clearly when the definition does not default-export a WorkflowSet', () => {
    const result = run(fixture('export const nothing = 1;\n'));
    expect(result.code).toBe(1);
    expect(result.stderr).toContain('must default-export a WorkflowSet');
  });

  it('fails clearly when the definition throws while loading', () => {
    const result = run(fixture("throw new Error('boom');\n"));
    expect(result.code).toBe(1);
    expect(result.stderr).toContain('boom');
  });

  it('derives repo and commit from git when not passed', () => {
    const dir = fixture();
    const gitEnv = { cwd: dir, stdio: 'ignore' as const };
    execFileSync('git', ['init', '-q'], gitEnv);
    execFileSync('git', ['remote', 'add', 'origin', 'git@github.com:copperbox/derived.git'], gitEnv);
    execFileSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-q', '--allow-empty', '-m', 'x'], gitEnv);

    let stdout = '';
    const code = runSynthCommand({ cwd: dir, stdout: (t) => (stdout += t), stderr: () => {} });
    expect(code).toBe(0);
    const model = JSON.parse(stdout);
    expect(model.repo).toBe('copperbox/derived');
    expect(model.commit).toMatch(/^[0-9a-f]{40}$/);
  });

  it('asks for --repo when there is no git remote to derive it from', () => {
    const dir = fixture();
    let stderr = '';
    const code = runSynthCommand({ cwd: dir, stdout: () => {}, stderr: (t) => (stderr += t) });
    expect(code).toBe(1);
    expect(stderr).toContain('--repo');
  });
});

describe('repoFromRemoteUrl', () => {
  it.each<[string, string | undefined]>([
    ['git@github.com:copperbox/millwright.git', 'copperbox/millwright'],
    ['https://github.com/copperbox/millwright.git', 'copperbox/millwright'],
    ['https://github.com/copperbox/millwright', 'copperbox/millwright'],
    ['ssh://git@github.com/copperbox/millwright.git', 'copperbox/millwright'],
    ['not-a-url', undefined],
  ])('%s -> %j', (url, expected) => {
    expect(repoFromRemoteUrl(url)).toBe(expected);
  });
});
