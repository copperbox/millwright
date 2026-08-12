import { describe, expect, it } from 'vitest';
import {
  CACHE_URI_ENV,
  OUT_URI_ENV,
  RunCoordinates,
  RunModelJob,
  buildspecForJob,
  dataPlaneEnvironment,
  isReservedEnvName,
  renderJobBuildspec,
  runInputSourceLocation,
  shellQuote,
  shimSourceLocation,
} from '../src';

const CTX = { deploymentName: 'ci', repo: 'octo/app' };
const COORDS: RunCoordinates = { repo: 'octo/app', workflow: 'ci', runNumber: 7 };

/** The acceptance-criteria job: cache + artifacts + secrets + skipIf. */
const FULL_JOB: RunModelJob = {
  name: 'publish',
  image: '123456789012.dkr.ecr.us-east-1.amazonaws.com/ci/node22-dind:latest',
  privileged: true,
  steps: [
    { run: 'npm ci && npm run build' },
    { run: 'npm publish', name: 'publish', skipIf: 'npm view myapp@$MILLWRIGHT_SHA version' },
  ],
  consumes: [{ job: 'build', artifact: 'dist' }],
  cache: { key: 'npm-abc123', paths: ['node_modules'], restoreKeys: ['npm-'] },
  produces: [{ name: 'packed', paths: ['out/pack'] }],
  secrets: {
    NPM_TOKEN: { parameter: 'npm-token' },
    SHARED: { parameter: 'db-url', scope: 'platform' },
    DOCKERHUB: { secretsManager: 'arn:aws:secretsmanager:us-east-1:1:secret:prod/dockerhub' },
  },
};

const PLAIN_JOB: RunModelJob = {
  name: 'build',
  image: 'public.ecr.aws/docker/library/node:22',
  steps: [{ run: 'make' }],
};

describe('renderJobBuildspec', () => {
  it('renders the full acceptance-criteria job (snapshot)', () => {
    expect(renderJobBuildspec(FULL_JOB, CTX)).toMatchSnapshot();
  });

  it('renders a minimal job (snapshot)', () => {
    expect(renderJobBuildspec(PLAIN_JOB, CTX)).toMatchSnapshot();
  });

  it('emits JSON, which CodeBuild accepts as valid YAML', () => {
    const parsed = JSON.parse(renderJobBuildspec(FULL_JOB, CTX));
    expect(parsed.version).toBe('0.2');
    expect(parsed.phases.build.commands).toHaveLength(2);
  });

  it('limits repo-derived content to the step list and declared env names', () => {
    const spec = renderJobBuildspec(FULL_JOB, CTX);
    // Repo-authored strings appear only as quoted arguments to the shim or
    // inside the env blocks — never as bare commands.
    const { phases } = buildspecForJob(FULL_JOB, CTX);
    for (const phase of Object.values(phases)) {
      for (const command of phase.commands) {
        expect(command).toMatch(/millwright-shim|docker/);
      }
    }
    expect(spec).toContain(`'npm ci && npm run build'`);
  });
});

describe('buildspec shape (spec §11.2)', () => {
  it('preludes dockerd only for privileged jobs, behind a socket-liveness guard', () => {
    const privileged = buildspecForJob(FULL_JOB, CTX);
    expect(privileged.phases.install!.commands[0]).toContain('if ! docker info');
    expect(privileged.phases.install!.commands[0]).toContain('dockerd');
    expect(buildspecForJob(PLAIN_JOB, CTX).phases.install).toBeUndefined();
  });

  it('unpacks the source package first — jobs never clone', () => {
    const spec = buildspecForJob(PLAIN_JOB, CTX);
    expect(spec.phases.pre_build.commands[0]).toContain('source unpack --archive source.tar.gz');
  });

  it('fetches consumed artifacts and restores the cache before the steps', () => {
    const spec = buildspecForJob(FULL_JOB, CTX);
    expect(spec.phases.pre_build.commands[1]).toContain(`artifact fetch --job 'build' --name 'dist'`);
    expect(spec.phases.pre_build.commands[2]).toContain(
      `cache restore --key 'npm-abc123' --restore-key 'npm-' --path 'node_modules'`,
    );
  });

  it('shim-wraps every step and passes skipIf through', () => {
    const spec = buildspecForJob(FULL_JOB, CTX);
    expect(spec.phases.build.commands[0]).toBe(
      `sh "\${MILLWRIGHT_SHIM_DIR:-$CODEBUILD_SRC_DIR_shim}/millwright-shim" step ` +
        `--index 0 -- 'npm ci && npm run build'`,
    );
    expect(spec.phases.build.commands[1]).toContain(
      `--index 1 --name 'publish' --skip-if 'npm view myapp@$MILLWRIGHT_SHA version'`,
    );
  });

  it('uploads artifacts and saves the cache only for a succeeding build', () => {
    const spec = buildspecForJob(FULL_JOB, CTX);
    const [upload, save] = spec.phases.post_build!.commands;
    expect(upload).toContain('[ "${CODEBUILD_BUILD_SUCCEEDING:-1}" = "1" ]');
    expect(upload).toContain(`artifact upload --name 'packed' --path 'out/pack'`);
    // Save carries no restore keys: an exact hit was recorded at restore and
    // makes the shim's save a no-op.
    expect(save).toContain(`cache save --key 'npm-abc123' --path 'node_modules'`);
    expect(save).not.toContain('--restore-key');
  });

  it('omits post_build entirely without artifacts or cache', () => {
    expect(buildspecForJob(PLAIN_JOB, CTX).phases.post_build).toBeUndefined();
  });
});

describe('secret injection (spec §11.2)', () => {
  it('resolves parameter references under the deployment, defaulting scope to the repo', () => {
    const { env } = buildspecForJob(FULL_JOB, CTX);
    expect(env['parameter-store']).toEqual({
      NPM_TOKEN: '/millwright/ci/secrets/octo/app/npm-token',
      SHARED: '/millwright/ci/secrets/platform/db-url',
    });
    expect(env['secrets-manager']).toEqual({
      DOCKERHUB: 'arn:aws:secretsmanager:us-east-1:1:secret:prod/dockerhub',
    });
  });

  it('omits empty secret blocks', () => {
    const { env } = buildspecForJob(PLAIN_JOB, CTX);
    expect(env['parameter-store']).toBeUndefined();
    expect(env['secrets-manager']).toBeUndefined();
  });

  it('drops secrets aimed at reserved env names', () => {
    const job: RunModelJob = {
      ...PLAIN_JOB,
      secrets: {
        AWS_ACCESS_KEY_ID: { parameter: 'evil' },
        MILLWRIGHT_JOB: { parameter: 'evil' },
        CODEBUILD_BUILD_SUCCEEDING: { parameter: 'evil' },
        FINE: { parameter: 'npm-token' },
      },
    };
    const { env } = buildspecForJob(job, CTX);
    expect(env['parameter-store']).toEqual({ FINE: '/millwright/ci/secrets/octo/app/npm-token' });
  });

  it('fails loud on a parameter name that cannot form an SSM path', () => {
    const job: RunModelJob = {
      ...PLAIN_JOB,
      secrets: { X: { parameter: 'has space' } },
    };
    expect(() => buildspecForJob(job, CTX)).toThrow(/secret name/);
  });
});

describe('reserved env names', () => {
  it('reserves the control-plane namespaces case-insensitively', () => {
    expect(isReservedEnvName('MILLWRIGHT_RUN_ID')).toBe(true);
    expect(isReservedEnvName('aws_secret_access_key')).toBe(true);
    expect(isReservedEnvName('CodeBuild_X')).toBe(true);
    expect(isReservedEnvName('NPM_TOKEN')).toBe(false);
    expect(isReservedEnvName('AWSOME')).toBe(false);
  });
});

describe('shellQuote', () => {
  it('makes hostile strings one safe shell word', () => {
    expect(shellQuote('plain')).toBe(`'plain'`);
    expect(shellQuote(`it's; rm -rf /`)).toBe(`'it'\\''s; rm -rf /'`);
    expect(shellQuote('$HOME `id` "x"')).toBe(`'$HOME \`id\` "x"'`);
  });
});

describe('dispatch-side locations', () => {
  it('derives the data-plane env vars from the run coordinates', () => {
    expect(dataPlaneEnvironment(COORDS, 'bkt')).toEqual({
      [OUT_URI_ENV]: 's3://bkt/runs/octo/app/ci/7/out',
      [CACHE_URI_ENV]: 's3://bkt/cache/octo/app',
    });
  });

  it('locates the primary source at the run in/ prefix and the shim under control/', () => {
    expect(runInputSourceLocation(COORDS, 'bkt')).toBe('bkt/runs/octo/app/ci/7/in/');
    expect(shimSourceLocation('bkt')).toBe('bkt/control/shim/');
  });
});
