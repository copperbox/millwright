import { describe, expect, it } from 'vitest';
import {
  Artifact,
  Cache,
  Compute,
  Diagnostic,
  hashFiles,
  SCHEMA_VERSION,
  Secret,
  Step,
  SynthError,
  SynthOptions,
  synthesize,
  Trigger,
  validateRunModel,
  Workflow,
  WorkflowSet,
} from '../src';

const IDENTITY: SynthOptions = {
  repo: 'copperbox/example',
  commit: 'deadbeef',
  // Deterministic stand-in for the CLI's real resolver — hashing happens at
  // synth against the checked-out source, which unit tests do not have.
  resolveHashFiles: (patterns) => `h${patterns.length}`,
};

/** A definition exercising every construct the spec pins (§4.2). */
function everyConstructSet(): WorkflowSet {
  const app = new WorkflowSet({ compute: Compute.ARM_SMALL });

  const ci = new Workflow(app, 'ci', {
    on: [Trigger.push({ branches: ['main'] }), Trigger.pullRequest()],
    image: 'public.ecr.aws/docker/library/node:22',
  });
  const build = ci.job('build', {
    cache: Cache.keyed({
      key: ['npm-', hashFiles('package-lock.json')],
      paths: ['node_modules'],
      restoreKeys: ['npm-'],
    }),
    steps: ['npm ci', 'npm test', 'npm run build'],
    produces: { dist: Artifact.dir('dist'), report: Artifact.file('coverage/report.xml') },
  });
  ci.job('integration', {
    consumes: { dist: build.artifacts.dist },
    steps: ['npm run test:integration -- --dist dist/'],
  });
  // Matrices are loops: independent jobs, no matrix DSL.
  for (const version of ['18', '20', '22']) {
    ci.job(`test-node${version}`, {
      image: `public.ecr.aws/docker/library/node:${version}`,
      steps: ['npm ci', 'npm test'],
    });
  }

  const release = new Workflow(app, 'release', {
    on: [Trigger.tag({ pattern: 'v*' }), Trigger.cron('0 4 * * *')],
    concurrency: { group: 'deploy-${repo}', policy: 'queue' },
  });
  const publish = release.job('publish', {
    image: 'public.ecr.aws/docker/library/docker:27-dind',
    compute: Compute.X86_LARGE,
    privileged: true,
    timeout: { minutes: 30 },
    secrets: {
      NPM_TOKEN: Secret.named('npm-token'),
      SHARED: Secret.named('deploy-key', { scope: 'platform' }),
      DOCKERHUB: Secret.fromSecretsManager(
        'arn:aws:secretsmanager:us-east-1:123456789012:secret:prod/dockerhub',
      ),
    },
    steps: [
      'npm ci && npm run build',
      Step.run('npm publish', { skipIf: 'npm view myapp@$MILLWRIGHT_TAG version' }),
      'docker push myapp:$MILLWRIGHT_TAG',
    ],
  });
  release.job('announce', {
    image: 'public.ecr.aws/docker/library/alpine:3',
    dependsOn: [publish],
    steps: ['echo released'],
  });

  const migrate = new Workflow(app, 'db-migrate', {
    on: [
      Trigger.manual({
        inputs: {
          environment: { choices: ['staging', 'prod'], default: 'staging' },
          dryRun: { type: 'boolean', default: true },
        },
      }),
    ],
    image: 'public.ecr.aws/docker/library/node:22',
  });
  migrate.job('migrate', {
    secrets: { DATABASE_URL: Secret.named('db-url') },
    steps: (inputs) => [
      `npx migrate ${inputs.dryRun ? '--dry-run' : ''} --env ${inputs.environment}`,
    ],
  });

  return app;
}

function synthErrors(set: WorkflowSet, options: SynthOptions = IDENTITY): readonly Diagnostic[] {
  try {
    synthesize(set, options);
  } catch (err) {
    if (err instanceof SynthError) {
      return err.errors;
    }
    throw err;
  }
  throw new Error('expected synthesize to throw SynthError');
}

describe('synthesize — the happy path', () => {
  it('compiles a definition using every construct to a schema-valid model', () => {
    const { model } = synthesize(everyConstructSet(), IDENTITY);
    expect(validateRunModel(model)).toEqual({ ok: true, issues: [] });
    expect(validateRunModel(JSON.parse(JSON.stringify(model))).ok).toBe(true);

    expect(model.schemaVersion).toBe(SCHEMA_VERSION);
    expect(model.repo).toBe('copperbox/example');
    expect(model.commit).toBe('deadbeef');
    expect(model.workflows.map((w) => w.name)).toEqual(['ci', 'release', 'db-migrate']);

    const ci = model.workflows[0];
    expect(ci.triggers).toEqual([
      { kind: 'push', branches: ['main'] },
      { kind: 'pull_request' },
    ]);
    expect(ci.concurrency).toBeUndefined();
    const build = ci.jobs[0];
    expect(build.image).toBe('public.ecr.aws/docker/library/node:22'); // from the Workflow
    expect(build.compute).toEqual({ arch: 'arm64', size: 'small' });
    expect(build.privileged).toBe(false);
    expect(build.timeoutMinutes).toBeUndefined();
    expect(build.cache).toEqual({
      key: 'npm-h1',
      paths: ['node_modules'],
      restoreKeys: ['npm-'],
    });
    expect(build.produces).toEqual([
      { name: 'dist', paths: ['dist'] },
      { name: 'report', paths: ['coverage/report.xml'] },
    ]);
    expect(ci.jobs[1].consumes).toEqual([{ job: 'build', artifact: 'dist' }]);
    expect(ci.jobs.map((j) => j.name)).toContain('test-node20');

    const release = model.workflows[1];
    expect(release.triggers).toEqual([
      { kind: 'tag', pattern: 'v*' },
      { kind: 'cron', expression: '0 4 * * *' },
    ]);
    expect(release.concurrency).toEqual({ group: 'deploy-${repo}', policy: 'queue' });
    const publish = release.jobs[0];
    expect(publish.compute).toEqual({ arch: 'x86_64', size: 'large' });
    expect(publish.privileged).toBe(true);
    expect(publish.timeoutMinutes).toBe(30);
    expect(publish.secrets).toEqual({
      NPM_TOKEN: { parameter: 'npm-token' },
      SHARED: { parameter: 'deploy-key', scope: 'platform' },
      DOCKERHUB: {
        secretsManager: 'arn:aws:secretsmanager:us-east-1:123456789012:secret:prod/dockerhub',
      },
    });
    expect(publish.steps[1]).toEqual({
      run: 'npm publish',
      skipIf: 'npm view myapp@$MILLWRIGHT_TAG version',
    });
    expect(release.jobs[1].dependsOn).toEqual(['publish']);

    const migrate = model.workflows[2];
    expect(migrate.triggers[0]).toEqual({
      kind: 'manual',
      inputs: {
        environment: { type: 'choice', choices: ['staging', 'prod'], default: 'staging' },
        dryRun: { type: 'boolean', default: true },
      },
    });
    // Steps factory resolved with declared defaults when not dispatching.
    expect(migrate.jobs[0].steps).toEqual([{ run: 'npx migrate --dry-run --env staging' }]);
  });

  it('is JSON-stable: serializing and reparsing loses nothing', () => {
    const { model } = synthesize(everyConstructSet(), IDENTITY);
    expect(JSON.parse(JSON.stringify(model))).toEqual(model);
  });

  it('cascades image job > Workflow > WorkflowSet', () => {
    const app = new WorkflowSet({ image: 'set.example.com/base:1' });
    const wf = new Workflow(app, 'ci', { on: [Trigger.push()], image: 'wf.example.com/base:1' });
    wf.job('from-workflow', { steps: ['true'] });
    wf.job('from-job', { image: 'job.example.com/base:1', steps: ['true'] });
    const other = new Workflow(app, 'other', { on: [Trigger.push()] });
    other.job('from-set', { steps: ['true'] });
    const { model } = synthesize(app, IDENTITY);
    expect(model.workflows[0].jobs.map((j) => j.image)).toEqual([
      'wf.example.com/base:1',
      'job.example.com/base:1',
    ]);
    expect(model.workflows[1].jobs[0].image).toBe('set.example.com/base:1');
  });

  it('defaults compute to ARM small through the same cascade', () => {
    const app = new WorkflowSet({ image: 'r.example.com/i:1', compute: Compute.ARM_LARGE });
    const wf = new Workflow(app, 'ci', { on: [Trigger.push()], compute: Compute.ARM_MEDIUM });
    wf.job('a', { steps: ['true'] });
    wf.job('b', { compute: Compute.X86_SMALL, steps: ['true'] });
    const bare = new Workflow(app, 'bare', { on: [Trigger.push()] });
    bare.job('c', { steps: ['true'] });
    const { model } = synthesize(app, IDENTITY);
    expect(model.workflows[0].jobs[0].compute).toEqual({ arch: 'arm64', size: 'medium' });
    expect(model.workflows[0].jobs[1].compute).toEqual({ arch: 'x86_64', size: 'small' });
    expect(model.workflows[1].jobs[0].compute).toEqual({ arch: 'arm64', size: 'large' });

    const plain = new WorkflowSet({ image: 'r.example.com/i:1' });
    new Workflow(plain, 'ci', { on: [Trigger.push()] }).job('d', { steps: ['true'] });
    expect(synthesize(plain, IDENTITY).model.workflows[0].jobs[0].compute).toEqual({
      arch: 'arm64',
      size: 'small',
    });
  });
});

describe('synthesize — manual dispatch inputs', () => {
  function migrateSet(): WorkflowSet {
    const app = new WorkflowSet({ image: 'r.example.com/node:22' });
    const wf = new Workflow(app, 'db-migrate', {
      on: [
        Trigger.manual({
          inputs: {
            environment: { choices: ['staging', 'prod'], default: 'staging' },
            dryRun: { type: 'boolean', default: true },
          },
        }),
      ],
    });
    wf.job('migrate', {
      steps: (inputs) => [
        `npx migrate ${inputs.dryRun ? '--dry-run' : ''} --env ${inputs.environment}`,
      ],
    });
    return app;
  }

  it('flows typed dispatch inputs into steps factories', () => {
    const { model } = synthesize(migrateSet(), {
      ...IDENTITY,
      dispatch: { workflow: 'db-migrate', inputs: { environment: 'prod', dryRun: false } },
    });
    expect(model.workflows[0].jobs[0].steps).toEqual([{ run: 'npx migrate  --env prod' }]);
  });

  it('rejects values outside a choice input', () => {
    const errors = synthErrors(migrateSet(), {
      ...IDENTITY,
      dispatch: { workflow: 'db-migrate', inputs: { environment: 'chaos' } },
    });
    expect(errors).toMatchObject([{ code: 'invalid-input-value' }]);
    expect(errors[0].message).toContain('staging, prod');
  });

  it('rejects non-boolean values for boolean inputs and unknown input names', () => {
    const errors = synthErrors(migrateSet(), {
      ...IDENTITY,
      dispatch: { workflow: 'db-migrate', inputs: { dryRun: 'yes', verbose: true } },
    });
    expect(errors.map((e) => e.code).sort()).toEqual(['invalid-input-value', 'unknown-input']);
  });

  it('requires a value for a choice input with no default', () => {
    const app = new WorkflowSet({ image: 'r.example.com/i:1' });
    const wf = new Workflow(app, 'deploy', {
      on: [Trigger.manual({ inputs: { environment: { choices: ['staging', 'prod'] } } })],
    });
    wf.job('go', { steps: (inputs) => [`deploy ${inputs.environment}`] });
    const errors = synthErrors(app, { ...IDENTITY, dispatch: { workflow: 'deploy' } });
    expect(errors).toMatchObject([{ code: 'missing-input' }]);
  });

  it('rejects dispatching an unknown or non-manual workflow', () => {
    expect(
      synthErrors(migrateSet(), { ...IDENTITY, dispatch: { workflow: 'nope' } }),
    ).toMatchObject([{ code: 'unknown-dispatch-workflow' }]);

    const app = new WorkflowSet({ image: 'r.example.com/i:1' });
    new Workflow(app, 'ci', { on: [Trigger.push()] }).job('a', { steps: ['true'] });
    expect(
      synthErrors(app, { ...IDENTITY, dispatch: { workflow: 'ci' } }),
    ).toMatchObject([{ code: 'not-manually-dispatchable' }]);
  });
});

describe('synthesize — errors', () => {
  it('fails when a job resolves to no image, naming the cascade', () => {
    const app = new WorkflowSet();
    new Workflow(app, 'ci', { on: [Trigger.push()] }).job('build', { steps: ['true'] });
    const errors = synthErrors(app);
    expect(errors).toMatchObject([{ code: 'image-unresolved', workflow: 'ci', job: 'build' }]);
    expect(errors[0].message).toMatch(/job, its Workflow, or the WorkflowSet/);
  });

  it('fails on consumes reaching across workflows', () => {
    const app = new WorkflowSet({ image: 'r.example.com/i:1' });
    const ci = new Workflow(app, 'ci', { on: [Trigger.push()] });
    const build = ci.job('build', {
      steps: ['true'],
      produces: { dist: Artifact.dir('dist') },
    });
    const deploy = new Workflow(app, 'deploy', { on: [Trigger.tag({ pattern: 'v*' })] });
    deploy.job('ship', { consumes: { dist: build.artifacts.dist }, steps: ['true'] });
    const errors = synthErrors(app);
    expect(errors).toMatchObject([{ code: 'consumes-unmatched', workflow: 'deploy', job: 'ship' }]);
    expect(errors[0].message).toContain('same workflow');
  });

  it('fails on dependsOn reaching across workflows', () => {
    const app = new WorkflowSet({ image: 'r.example.com/i:1' });
    const ci = new Workflow(app, 'ci', { on: [Trigger.push()] });
    const build = ci.job('build', { steps: ['true'] });
    const deploy = new Workflow(app, 'deploy', { on: [Trigger.tag({ pattern: 'v*' })] });
    deploy.job('ship', { dependsOn: [build], steps: ['true'] });
    expect(synthErrors(app)).toMatchObject([{ code: 'depends-on-unmatched' }]);
  });

  it('fails on a dependency cycle between consumes and dependsOn', () => {
    const app = new WorkflowSet({ image: 'r.example.com/i:1' });
    const ci = new Workflow(app, 'ci', { on: [Trigger.push()] });
    const a = ci.job('a', { steps: ['true'], produces: { out: Artifact.dir('out') } });
    const b = ci.job('b', { consumes: { out: a.artifacts.out }, steps: ['true'] });
    // Close the loop after the fact: a dependsOn b.
    (a.props as { dependsOn?: unknown }).dependsOn = [b];
    const errors = synthErrors(app);
    expect(errors).toMatchObject([{ code: 'invalid-model' }]);
    expect(errors[0].message).toMatch(/dependency cycle .* (a -> b -> a|b -> a -> b)/);
  });

  it('fails loud when the model schemaVersion is newer than the control plane', () => {
    const errors = synthErrors(everyConstructSet(), {
      ...IDENTITY,
      controlPlaneSchemaVersion: SCHEMA_VERSION - 1,
    });
    expect(errors).toMatchObject([{ code: 'schema-version-skew' }]);
    expect(errors[0].message).toContain('upgrade the deployed control plane');
    // Equal versions are fine.
    expect(
      synthesize(everyConstructSet(), { ...IDENTITY, controlPlaneSchemaVersion: SCHEMA_VERSION })
        .model.schemaVersion,
    ).toBe(SCHEMA_VERSION);
  });

  it('fails when hashFiles is used without a resolver — hashing happens at synth', () => {
    const app = new WorkflowSet({ image: 'r.example.com/i:1' });
    new Workflow(app, 'ci', { on: [Trigger.push()] }).job('build', {
      cache: Cache.keyed({ key: ['npm-', hashFiles('package-lock.json')], paths: ['node_modules'] }),
      steps: ['true'],
    });
    const errors = synthErrors(app, { repo: 'copperbox/example', commit: 'deadbeef' });
    expect(errors).toMatchObject([{ code: 'hash-files-unresolvable', workflow: 'ci', job: 'build' }]);
  });

  it('fails on cache keys that resolve empty or carry S3-hostile characters', () => {
    const cacheJob = (key: (string | ReturnType<typeof hashFiles>)[]): WorkflowSet => {
      const app = new WorkflowSet({ image: 'r.example.com/i:1' });
      new Workflow(app, 'ci', { on: [Trigger.push()] }).job('build', {
        cache: Cache.keyed({ key, paths: ['node_modules'] }),
        steps: ['true'],
      });
      return app;
    };
    // hashFiles matching nothing resolves to '' — an all-hash key vanishes.
    expect(
      synthErrors(cacheJob([hashFiles('no-such-file')]), {
        ...IDENTITY,
        resolveHashFiles: () => '',
      }),
    ).toMatchObject([{ code: 'cache-key-empty' }]);
    expect(synthErrors(cacheJob(['npm/x']))).toMatchObject([{ code: 'cache-key-invalid' }]);
    expect(synthErrors(cacheJob(['npm-..x']))).toMatchObject([{ code: 'cache-key-invalid' }]);
  });

  it('fails on restore keys with separator characters', () => {
    const app = new WorkflowSet({ image: 'r.example.com/i:1' });
    new Workflow(app, 'ci', { on: [Trigger.push()] }).job('build', {
      cache: Cache.keyed({ key: ['npm-x'], paths: ['node_modules'], restoreKeys: ['npm/'] }),
      steps: ['true'],
    });
    expect(synthErrors(app)).toMatchObject([{ code: 'restore-key-invalid' }]);
  });

  it('fails on malformed cron expressions', () => {
    const app = new WorkflowSet({ image: 'r.example.com/i:1' });
    new Workflow(app, 'nightly', { on: [Trigger.cron('61 * * * *')] }).job('a', { steps: ['true'] });
    expect(synthErrors(app)).toMatchObject([{ code: 'invalid-cron', workflow: 'nightly' }]);
  });

  it('fails on invalid repo identity, commit, and timeout', () => {
    const app = new WorkflowSet({ image: 'r.example.com/i:1' });
    new Workflow(app, 'ci', { on: [Trigger.push()] }).job('a', {
      steps: ['true'],
      timeout: { minutes: 0 },
    });
    const errors = synthErrors(app, { repo: 'not-owner-slash-name', commit: '' });
    expect(errors.map((e) => e.code).sort()).toEqual([
      'invalid-commit',
      'invalid-repo',
      'invalid-timeout',
    ]);
  });

  it('fails on an empty steps list and a manual default outside its choices', () => {
    const app = new WorkflowSet({ image: 'r.example.com/i:1' });
    const wf = new Workflow(app, 'ci', {
      on: [Trigger.manual({ inputs: { env: { choices: ['a'], default: 'z' } } })],
    });
    wf.job('a', { steps: [] });
    const errors = synthErrors(app);
    expect(errors.map((e) => e.code).sort()).toEqual(['invalid-input-default', 'no-steps']);
  });

  it('aggregates every error instead of stopping at the first', () => {
    const app = new WorkflowSet();
    const ci = new Workflow(app, 'ci', { on: [Trigger.push()] });
    ci.job('a', { steps: ['true'] });
    ci.job('b', { steps: ['true'] });
    const errors = synthErrors(app);
    expect(errors).toHaveLength(2);
    expect(new SynthError(errors).message).toContain('2 errors');
  });
});

describe('synthesize — lints', () => {
  const lintCodes = (diagnostics: readonly Diagnostic[]): string[] =>
    diagnostics.map((d) => d.code);

  it('flags implicit Docker Hub references with the mirror recommendation', () => {
    const app = new WorkflowSet();
    const wf = new Workflow(app, 'ci', { on: [Trigger.push()] });
    wf.job('bare', { image: 'node:22', steps: ['true'] });
    wf.job('scoped', { image: 'myorg/tool:1', steps: ['true'] });
    wf.job('mirrored', { image: 'public.ecr.aws/docker/library/node:22', steps: ['true'] });
    wf.job('ported', { image: 'registry.local:5000/node:22', steps: ['true'] });
    const { diagnostics } = synthesize(app, IDENTITY);
    const hits = diagnostics.filter((d) => d.code === 'implicit-docker-hub');
    expect(hits.map((d) => d.job)).toEqual(['bare', 'scoped']);
    expect(hits[0].message).toContain('public.ecr.aws/docker/library/node:22');
    expect(hits[1].message).toContain('explicit registry');
    expect(hits.every((d) => d.level === 'warning')).toBe(true);
  });

  it('warns once that secret masking is exact-match-only when secrets are declared', () => {
    const { diagnostics } = synthesize(everyConstructSet(), IDENTITY);
    const hits = diagnostics.filter((d) => d.code === 'secret-masking-exact-match');
    expect(hits).toHaveLength(1);
    expect(hits[0].message).toContain('release/publish');
    expect(hits[0].message).toContain('db-migrate/migrate');

    const noSecrets = new WorkflowSet({ image: 'r.example.com/i:1' });
    new Workflow(noSecrets, 'ci', { on: [Trigger.push()] }).job('a', { steps: ['true'] });
    expect(lintCodes(synthesize(noSecrets, IDENTITY).diagnostics)).not.toContain(
      'secret-masking-exact-match',
    );
  });

  it('warns when Trigger.cron is finer than the deployment poll cadence', () => {
    const app = new WorkflowSet({ image: 'r.example.com/i:1' });
    new Workflow(app, 'often', { on: [Trigger.cron('*/2 * * * *')] }).job('a', { steps: ['true'] });
    new Workflow(app, 'hourly', { on: [Trigger.cron('30 * * * *')] }).job('b', { steps: ['true'] });

    const cloud = synthesize(app, { ...IDENTITY, pollCadenceMinutes: 5 });
    const hits = cloud.diagnostics.filter((d) => d.code === 'cron-finer-than-poll-cadence');
    expect(hits).toHaveLength(1);
    expect(hits[0].workflow).toBe('often');
    expect(hits[0].message).toContain('every 2 minutes');

    // Local synth has no deployment; the lint stays quiet.
    expect(lintCodes(synthesize(app, IDENTITY).diagnostics)).not.toContain(
      'cron-finer-than-poll-cadence',
    );
  });

  it('warns as fail-fast UX when the ref is outside secretsAllowedRefs', () => {
    const app = new WorkflowSet({ image: 'r.example.com/i:1' });
    const wf = new Workflow(app, 'ci', { on: [Trigger.push()] });
    wf.job('build', { secrets: { TOKEN: Secret.named('token') }, steps: ['true'] });

    const offRef = synthesize(app, {
      ...IDENTITY,
      ref: 'feature/x',
      secretsAllowedRefs: ['main', 'release/*'],
    });
    const hit = offRef.diagnostics.find((d) => d.code === 'secrets-ref-not-allowed');
    expect(hit?.message).toContain('fail-fast');
    expect(hit?.message).toContain('enforcement happens at dispatch');

    const onRef = synthesize(app, {
      ...IDENTITY,
      ref: 'release/1.2',
      secretsAllowedRefs: ['main', 'release/*'],
    });
    expect(lintCodes(onRef.diagnostics)).not.toContain('secrets-ref-not-allowed');

    // Without the repo config there is nothing to check against.
    expect(lintCodes(synthesize(app, { ...IDENTITY, ref: 'feature/x' }).diagnostics)).not.toContain(
      'secrets-ref-not-allowed',
    );
  });

  it('warns on unknown concurrency group tokens', () => {
    const app = new WorkflowSet({ image: 'r.example.com/i:1' });
    new Workflow(app, 'deploy', {
      on: [Trigger.push()],
      concurrency: { group: 'deploy-${branch}', policy: 'supersede' },
    }).job('a', { steps: ['true'] });
    const { diagnostics } = synthesize(app, IDENTITY);
    const hit = diagnostics.find((d) => d.code === 'unknown-concurrency-token');
    expect(hit?.message).toContain('${branch}');
    expect(hit?.message).toContain('${ref}');
  });
});
