/**
 * PROTOTYPE — discussion artifact for wayfinder ticket
 * "Workflow-definition construct API". Not a design commitment.
 *
 * Premise: this file lives in the *watched repo* at `millwright/workflows.ts`
 * (like .github/workflows, but code). `millwright synth` compiles it to the
 * declarative run model; the deployed control plane synthesizes the version at
 * the triggering commit, so workflow changes ride the same branch/PR flow as
 * the code they build. `millwright run ci --local` executes the same
 * definition locally.
 */

import {
  WorkflowSet, Workflow, Compute, Secret, Artifact, Cache, hashFiles, Trigger,
} from '@millwright/workflows';

const app = new WorkflowSet();

// ---------------------------------------------------------------------------
// 1. CI on push + PR checks — one workflow, two triggers
// ---------------------------------------------------------------------------

const ci = new Workflow(app, 'ci', {
  on: [
    Trigger.push({ branches: ['main'] }),          // tier 1: git-protocol event
    Trigger.pullRequest(),                          // tier 2: best-effort API event
  ],
});

const build = ci.job('build', {
  image: 'public.ecr.aws/docker/library/node:22',   // runner-image model TBD (#013)
  compute: Compute.ARM_SMALL,                       // default; here for visibility
  cache: Cache.keyed({
    key: hashFiles('package-lock.json'),
    paths: ['node_modules'],
    restoreKeys: ['npm-'],
  }),
  steps: [
    'npm ci',
    'npm test',
    'npm run build',
  ],
  produces: {
    dist: Artifact.dir('dist'),
  },
});

// Consuming a typed artifact creates the DAG edge — there is no `needs:`.
// A `consumes` with no matching `produces` fails at synth, not at 3am.
ci.job('integration', {
  image: 'public.ecr.aws/docker/library/node:22',
  consumes: { dist: build.artifacts.dist },
  steps: ['npm run test:integration -- --dist dist/'],
});

// ---------------------------------------------------------------------------
// 2. Deploy on tag — secrets, privileged docker build
// ---------------------------------------------------------------------------

const release = new Workflow(app, 'release', {
  on: [Trigger.tag({ pattern: 'v*' })],
});

release.job('publish', {
  image: 'public.ecr.aws/docker/library/node:22',
  privileged: true,                                 // docker-in-docker for the image build
  timeout: { minutes: 30 },
  secrets: {
    // Explicit declaration → synth emits a per-job IAM role that can read
    // exactly these two parameters and nothing else (#008).
    NPM_TOKEN: Secret.named('npm-token'),
    // Passthrough reference to an existing Secrets Manager secret:
    DOCKERHUB: Secret.fromSecretsManager('arn:aws:secretsmanager:...:prod/dockerhub'),
  },
  steps: [
    'npm ci && npm run build',
    'npm publish',
    'docker build -t myapp:$MILLWRIGHT_TAG .',
    'echo "$DOCKERHUB" | docker login -u myorg --password-stdin',
    'docker push myapp:$MILLWRIGHT_TAG',
  ],
});

// ---------------------------------------------------------------------------
// 3. Manual dispatch with *typed* inputs — impossible in GHA YAML
// ---------------------------------------------------------------------------

const dbMigrate = new Workflow(app, 'db-migrate', {
  on: [
    Trigger.manual({
      inputs: {
        environment: { choices: ['staging', 'prod'] as const, default: 'staging' },
        dryRun: { type: 'boolean', default: true },
      },
    }),
  ],
});

dbMigrate.job('migrate', {
  image: 'public.ecr.aws/docker/library/node:22',
  secrets: { DATABASE_URL: Secret.named('db-url') },
  // Inputs arrive typed: (inputs.environment: 'staging' | 'prod')
  steps: (inputs) => [
    `npx migrate ${inputs.dryRun ? '--dry-run' : ''} --env ${inputs.environment}`,
  ],
});

export default app;
