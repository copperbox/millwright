import { describe, expect, it } from 'vitest';
import {
  RunModelValidationError,
  assertValidRunModel,
  validateRunModel,
} from '../src';

/** A minimal but complete, valid document — the post-synth wire shape. */
function validDocument(): Record<string, unknown> {
  return JSON.parse(
    JSON.stringify({
      schemaVersion: 1,
      repo: 'copperbox/example',
      commit: 'deadbeef',
      workflows: [
        {
          name: 'ci',
          triggers: [
            { kind: 'push', branches: ['main'] },
            { kind: 'pull_request' },
            { kind: 'tag', pattern: 'v*' },
            { kind: 'cron', expression: '0 4 * * *' },
            {
              kind: 'manual',
              inputs: {
                environment: { type: 'choice', choices: ['staging', 'prod'], default: 'staging' },
                dryRun: { type: 'boolean', default: true },
              },
            },
          ],
          concurrency: { group: 'deploy-${repo}', policy: 'queue' },
          jobs: [
            {
              name: 'build',
              image: 'public.ecr.aws/docker/library/node:22',
              compute: { arch: 'arm64', size: 'small' },
              privileged: false,
              steps: [{ run: 'npm ci' }, { run: 'npm publish', skipIf: 'already-published' }],
              secrets: {
                NPM_TOKEN: { kind: 'named', name: 'npm-token' },
                SHARED: { kind: 'named', name: 'key', scope: 'platform' },
                HUB: { kind: 'secretsManager', arn: 'arn:aws:secretsmanager:x:y:secret:z' },
              },
              produces: { dist: { kind: 'dir', path: 'dist' } },
              consumes: {},
              dependsOn: [],
              cache: {
                key: [
                  { kind: 'literal', value: 'npm-' },
                  { kind: 'hashFiles', patterns: ['package-lock.json'] },
                ],
                paths: ['node_modules'],
                restoreKeys: ['npm-'],
              },
            },
            {
              name: 'integration',
              image: 'public.ecr.aws/docker/library/node:22',
              compute: { arch: 'x86_64', size: 'large' },
              privileged: true,
              timeoutMinutes: 30,
              steps: [{ run: 'npm run test:integration' }],
              secrets: {},
              produces: {},
              consumes: { dist: { job: 'build', artifact: 'dist' } },
              dependsOn: ['build'],
            },
          ],
        },
      ],
    }),
  );
}

function issuesOf(mutate: (doc: Record<string, unknown>) => void): string[] {
  const doc = validDocument();
  mutate(doc);
  return validateRunModel(doc).issues.map((i) => `${i.path}: ${i.message}`);
}

type Job = Record<string, unknown>;
const job = (doc: Record<string, unknown>, index = 0): Job =>
  ((doc.workflows as Job[])[0].jobs as Job[])[index];

describe('validateRunModel', () => {
  it('accepts a complete valid document', () => {
    expect(validateRunModel(validDocument())).toEqual({ ok: true, issues: [] });
  });

  it('rejects non-object roots', () => {
    for (const value of [null, 'x', 42, []]) {
      expect(validateRunModel(value).ok).toBe(false);
    }
  });

  it('rejects a schemaVersion newer than the control plane supports', () => {
    const doc = validDocument();
    const result = validateRunModel(doc, { controlPlaneSchemaVersion: 0 });
    expect(result.ok).toBe(false);
    expect(result.issues[0].message).toContain('newer than this control plane supports');
    expect(validateRunModel(doc, { controlPlaneSchemaVersion: 1 }).ok).toBe(true);
  });

  it('checks identity fields', () => {
    expect(issuesOf((d) => (d.schemaVersion = 0))[0]).toContain('positive integer');
    expect(issuesOf((d) => (d.repo = 'no-slash'))[0]).toContain('owner/name');
    expect(issuesOf((d) => (d.commit = ''))[0]).toContain('non-empty');
  });

  it('rejects duplicate workflow names, duplicate job names, and the reserved name', () => {
    expect(
      issuesOf((d) => {
        const workflows = d.workflows as Job[];
        workflows.push(JSON.parse(JSON.stringify(workflows[0])));
      }).join('\n'),
    ).toContain('duplicate workflow name "ci"');
    expect(
      issuesOf((d) => (job(d, 1).name = 'build')).join('\n'),
    ).toContain('duplicate job name "build"');
    expect(issuesOf((d) => (job(d).name = 'synth')).join('\n')).toContain('reserved by millwright');
  });

  it('rejects malformed triggers and manual inputs', () => {
    const triggers = (d: Record<string, unknown>): Job[] =>
      (d.workflows as Job[])[0].triggers as Job[];
    expect(issuesOf((d) => (triggers(d)[0].kind = 'webhook'))[0]).toContain('trigger kind');
    expect(issuesOf((d) => delete triggers(d)[2].pattern)[0]).toContain('tag pattern');
    expect(issuesOf((d) => (triggers(d)[3].expression = ''))[0]).toContain('cron expression');
    expect(
      issuesOf((d) => {
        (triggers(d)[4].inputs as Job).environment = { type: 'choice', choices: [], default: 'x' };
      }).join('\n'),
    ).toContain('at least one choice');
    expect(
      issuesOf((d) => {
        (triggers(d)[4].inputs as Job).dryRun = { type: 'boolean', default: 'yes' };
      })[0],
    ).toContain('must be a boolean');
    expect(
      issuesOf((d) => ((d.workflows as Job[])[0].triggers = []))[0],
    ).toContain('at least one trigger');
  });

  it('rejects malformed concurrency', () => {
    const wf = (d: Record<string, unknown>): Job => (d.workflows as Job[])[0];
    expect(issuesOf((d) => ((wf(d).concurrency as Job).policy = 'cancel'))[0]).toContain(
      'queue, supersede',
    );
    expect(issuesOf((d) => ((wf(d).concurrency as Job).group = ''))[0]).toContain(
      'concurrency group',
    );
  });

  it('rejects malformed job fields', () => {
    expect(issuesOf((d) => (job(d).image = ''))[0]).toContain('image');
    expect(issuesOf((d) => ((job(d).compute as Job).arch = 'riscv'))[0]).toContain('arm64, x86_64');
    expect(issuesOf((d) => ((job(d).compute as Job).size = 'xl'))[0]).toContain(
      'small, medium, large',
    );
    expect(issuesOf((d) => (job(d).privileged = 'yes'))[0]).toContain('privileged');
    expect(issuesOf((d) => (job(d, 1).timeoutMinutes = 2.5))[0]).toContain('positive integer');
    expect(issuesOf((d) => (job(d).steps = []))[0]).toContain('at least one step');
    expect(issuesOf((d) => ((job(d).steps as Job[])[0].run = ''))[0]).toContain('step command');
    expect(issuesOf((d) => ((job(d).secrets as Job).NPM_TOKEN = { kind: 'env' }))[0]).toContain(
      '"named" or "secretsManager"',
    );
    expect(
      issuesOf((d) => ((job(d).secrets as Job).HUB = { kind: 'secretsManager', arn: 'nope' }))[0],
    ).toContain('not a Secrets Manager ARN');
    expect(
      issuesOf((d) => ((job(d).produces as Job).dist = { kind: 'blob', path: 'x' }))[0],
    ).toContain('"dir" or "file"');
    expect(issuesOf((d) => ((job(d).cache as Job).paths = []))[0]).toContain('at least one path');
    expect(
      issuesOf((d) => (((job(d).cache as Job).key as Job[])[1] = { kind: 'hash' }))[0],
    ).toContain('"literal" or "hashFiles"');
  });

  it('rejects consumes without a matching produces', () => {
    // Producer job exists but does not produce the artifact.
    expect(
      issuesOf((d) => {
        (job(d, 1).consumes as Job).dist = { job: 'build', artifact: 'missing' };
      })[0],
    ).toContain('every consumes needs a matching produces');
    // Producer job does not exist at all.
    expect(
      issuesOf((d) => {
        (job(d, 1).consumes as Job).dist = { job: 'ghost', artifact: 'dist' };
      })[0],
    ).toContain('not a job in workflow "ci"');
  });

  it('rejects dependsOn naming a job that does not exist', () => {
    expect(issuesOf((d) => (job(d, 1).dependsOn = ['ghost']))[0]).toContain(
      'not a job in workflow "ci"',
    );
  });

  it('rejects dependency cycles, including self-dependencies', () => {
    expect(
      issuesOf((d) => (job(d, 0).dependsOn = ['integration'])).join('\n'),
    ).toContain('dependency cycle');
    expect(issuesOf((d) => (job(d, 1).dependsOn = ['integration'])).join('\n')).toContain(
      'dependency cycle',
    );
  });

  it('collects every issue in one pass', () => {
    const doc = validDocument();
    doc.commit = '';
    job(doc).image = '';
    job(doc, 1).dependsOn = ['ghost'];
    expect(validateRunModel(doc).issues.length).toBe(3);
  });

  it('assertValidRunModel throws a listing of all issues', () => {
    const doc = validDocument();
    doc.repo = '';
    expect(() => assertValidRunModel(doc)).toThrow(RunModelValidationError);
    expect(() => assertValidRunModel(doc)).toThrow(/repo/);
    expect(() => assertValidRunModel(validDocument())).not.toThrow();
  });
});
