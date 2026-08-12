import { describe, expect, it } from 'vitest';
import {
  Artifact,
  Cache,
  Compute,
  hashFiles,
  HashFilesToken,
  SCHEMA_VERSION,
  Secret,
  Step,
  Trigger,
  Workflow,
  WorkflowSet,
} from '../src';

describe('WorkflowSet / Workflow / Job', () => {
  it('registers workflows on the set', () => {
    const app = new WorkflowSet();
    const ci = new Workflow(app, 'ci', { on: [Trigger.push({ branches: ['main'] })] });
    expect(app.workflows).toEqual([ci]);
  });

  it('rejects a workflow with no triggers', () => {
    const app = new WorkflowSet();
    expect(() => new Workflow(app, 'ci', { on: [] })).toThrow(/at least one trigger/);
  });

  it('rejects duplicate workflow names', () => {
    const app = new WorkflowSet();
    new Workflow(app, 'ci', { on: [Trigger.pullRequest()] });
    expect(() => new Workflow(app, 'ci', { on: [Trigger.pullRequest()] })).toThrow(
      /already has a workflow named "ci"/,
    );
  });

  it('rejects duplicate job names within a workflow', () => {
    const app = new WorkflowSet();
    const ci = new Workflow(app, 'ci', { on: [Trigger.pullRequest()] });
    ci.job('build', { image: 'node:22', steps: ['npm test'] });
    expect(() => ci.job('build', { image: 'node:22', steps: ['npm test'] })).toThrow(
      /already has a job named "build"/,
    );
  });

  it('rejects the reserved job name "synth"', () => {
    const app = new WorkflowSet();
    const ci = new Workflow(app, 'ci', { on: [Trigger.pullRequest()] });
    expect(() => ci.job('synth', { image: 'node:22', steps: ['true'] })).toThrow(/reserved/);
  });

  it('exposes produced artifacts as typed refs for DAG edges', () => {
    const app = new WorkflowSet();
    const ci = new Workflow(app, 'ci', { on: [Trigger.push()] });
    const build = ci.job('build', {
      image: 'node:22',
      steps: ['npm run build'],
      produces: { dist: Artifact.dir('dist') },
    });
    const integration = ci.job('integration', {
      image: 'node:22',
      consumes: { dist: build.artifacts.dist },
      steps: ['npm run test:integration'],
    });
    expect(build.artifacts.dist.job).toBe(build);
    expect(build.artifacts.dist.artifactName).toBe('dist');
    expect(integration.props.consumes?.dist).toBe(build.artifacts.dist);
  });

  it('accepts inputs-driven step factories for manual workflows', () => {
    const app = new WorkflowSet();
    const wf = new Workflow(app, 'db-migrate', {
      on: [Trigger.manual({ inputs: { dryRun: { type: 'boolean', default: true } } })],
    });
    const job = wf.job('migrate', {
      image: 'node:22',
      steps: (inputs) => [`npx migrate ${inputs.dryRun ? '--dry-run' : ''}`],
    });
    const steps = job.props.steps;
    expect(typeof steps).toBe('function');
    expect((steps as (i: Record<string, unknown>) => string[])({ dryRun: true })).toEqual([
      'npx migrate --dry-run',
    ]);
  });
});

describe('triggers and values', () => {
  it('builds each trigger kind', () => {
    expect(Trigger.push({ branches: ['main'] }).kind).toBe('push');
    expect(Trigger.tag({ pattern: 'v*' }).kind).toBe('tag');
    expect(Trigger.pullRequest().kind).toBe('pull_request');
    expect(Trigger.cron('0 4 * * *').kind).toBe('cron');
    expect(Trigger.manual().kind).toBe('manual');
    expect(() => Trigger.cron('  ')).toThrow(/cron expression/);
    expect(() => Trigger.tag({ pattern: '' })).toThrow(/pattern/);
  });

  it('models secrets as named or Secrets Manager passthrough', () => {
    const named = Secret.named('npm-token');
    expect(named.kind).toBe('named');
    expect(named.ref).toBe('npm-token');
    expect(named.scope).toBeUndefined();
    expect(Secret.named('db-url', { scope: 'shared' }).scope).toBe('shared');
    const arn = 'arn:aws:secretsmanager:us-east-1:123456789012:secret:prod/dockerhub';
    expect(Secret.fromSecretsManager(arn).ref).toBe(arn);
    expect(() => Secret.fromSecretsManager('prod/dockerhub')).toThrow(/ARN/);
  });

  it('defers hashFiles into cache key tokens', () => {
    const cache = Cache.keyed({
      key: hashFiles('package-lock.json'),
      paths: ['node_modules'],
      restoreKeys: ['npm-'],
    });
    expect(cache.key).toHaveLength(1);
    expect(cache.key[0]).toBeInstanceOf(HashFilesToken);
    expect((cache.key[0] as HashFilesToken).patterns).toEqual(['package-lock.json']);
    expect(() => Cache.keyed({ key: 'k', paths: [] })).toThrow(/at least one path/);
    expect(() => hashFiles()).toThrow(/at least one file pattern/);
  });

  it('records skipIf on steps', () => {
    const step = Step.run('npm publish', { skipIf: 'npm view myapp@$TAG version' });
    expect(step.command).toBe('npm publish');
    expect(step.skipIf).toBe('npm view myapp@$TAG version');
  });

  it('defaults compute constants to the documented arch/size pairs', () => {
    expect(Compute.ARM_SMALL.arch).toBe('arm64');
    expect(Compute.ARM_SMALL.size).toBe('small');
    expect(Compute.X86_LARGE.arch).toBe('x86_64');
  });

  it('exports the run-model schema version', () => {
    expect(SCHEMA_VERSION).toBe(1);
  });
});
