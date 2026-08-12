import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  MODEL_OBJECT,
  SOURCE_OBJECT,
  SYNTH_ERROR_OBJECT,
  SynthJobConfigError,
  configFromEnv,
  prNumberFromRef,
  shortRefName,
} from '../src/synth-job/config';
import { installPlan } from '../src/synth-job/install';
import { RecordedCommand, SynthJobDeps, runSynthJob } from '../src/synth-job/synth-job';

const ENV = {
  MILLWRIGHT_REPO: 'octocat/app',
  MILLWRIGHT_SHA: 'a'.repeat(40),
  MILLWRIGHT_REF: 'refs/heads/main',
  MILLWRIGHT_DEST_BUCKET: 'millwright-artifacts',
  MILLWRIGHT_DEST_PREFIX: 'runs/octocat/app/ci/7/in/',
  MILLWRIGHT_SCHEMA_CEILING: '1',
  MILLWRIGHT_DEPLOY_KEY: '-----BEGIN OPENSSH PRIVATE KEY-----\nabc\n-----END OPENSSH PRIVATE KEY-----\n',
  MILLWRIGHT_HOST_KEYS: 'github.com ssh-ed25519 AAAA...pinned\n',
};

describe('configFromEnv', () => {
  it('reads the full contract, defaulting the optional fields', () => {
    const config = configFromEnv(ENV);
    expect(config.repo).toBe('octocat/app');
    expect(config.sha).toBe('a'.repeat(40));
    expect(config.ref).toBe('refs/heads/main');
    expect(config.destBucket).toBe('millwright-artifacts');
    expect(config.destPrefix).toBe('runs/octocat/app/ci/7/in/');
    expect(config.schemaCeiling).toBe(1);
    expect(config.pollCadenceMinutes).toBeUndefined();
    expect(config.secretsAllowedRefs).toBeUndefined();
  });

  it('parses secretsAllowedRefs out of the repo config JSON', () => {
    const config = configFromEnv({
      ...ENV,
      MILLWRIGHT_REPO_CONFIG: '{"secretsAllowedRefs":["main","release/*"]}',
      MILLWRIGHT_POLL_CADENCE_MINUTES: '2',
    });
    expect(config.secretsAllowedRefs).toEqual(['main', 'release/*']);
    expect(config.pollCadenceMinutes).toBe(2);
  });

  it('tolerates malformed repo config JSON (lint inputs, never blocking)', () => {
    const config = configFromEnv({ ...ENV, MILLWRIGHT_REPO_CONFIG: 'not json' });
    expect(config.secretsAllowedRefs).toBeUndefined();
  });

  it('names every missing required variable at once', () => {
    expect(() => configFromEnv({})).toThrowError(SynthJobConfigError);
    expect(() => configFromEnv({})).toThrow(/MILLWRIGHT_REPO.*MILLWRIGHT_SHA/s);
  });
});

describe('ref helpers', () => {
  it('shortens branch and tag refs, keeps everything else full', () => {
    expect(shortRefName('refs/heads/main')).toBe('main');
    expect(shortRefName('refs/heads/release/1.2')).toBe('release/1.2');
    expect(shortRefName('refs/tags/v1.0')).toBe('v1.0');
    // PR run identities stay full refs — structurally unmatchable by the
    // secrets allowlist (spec §12a).
    expect(shortRefName('refs/pull/17/head')).toBe('refs/pull/17/head');
  });

  it('finds the PR number only in pull refs', () => {
    expect(prNumberFromRef('refs/pull/17/head')).toBe(17);
    expect(prNumberFromRef('refs/pull/17/merge')).toBe(17);
    expect(prNumberFromRef('refs/heads/pull/17/head')).toBeUndefined();
    expect(prNumberFromRef('refs/heads/main')).toBeUndefined();
  });
});

describe('installPlan (spec §7.2 install contract)', () => {
  const has = (...files: string[]) => (file: string) => files.includes(file);

  it('package-lock.json → npm ci', () => {
    expect(installPlan(has('package.json', 'package-lock.json'))).toEqual({
      file: 'npm',
      args: ['ci'],
    });
  });

  it('pnpm-lock.yaml → pnpm install --frozen-lockfile via corepack', () => {
    expect(installPlan(has('package.json', 'pnpm-lock.yaml'))).toEqual({
      file: 'corepack',
      args: ['pnpm', 'install', '--frozen-lockfile'],
    });
  });

  it('yarn.lock → yarn install --frozen-lockfile via corepack', () => {
    expect(installPlan(has('package.json', 'yarn.lock'))).toEqual({
      file: 'corepack',
      args: ['yarn', 'install', '--frozen-lockfile'],
    });
  });

  it('package-lock wins when several lockfiles coexist', () => {
    expect(
      installPlan(has('package.json', 'package-lock.json', 'yarn.lock', 'pnpm-lock.yaml')),
    ).toEqual({ file: 'npm', args: ['ci'] });
  });

  it('no lockfile → npm install with the non-reproducible-install warning', () => {
    expect(installPlan(has('package.json'))).toEqual({
      file: 'npm',
      args: ['install'],
      warning: expect.stringContaining('lockfile'),
    });
  });

  it('no package.json → nothing to install', () => {
    expect(installPlan(has())).toBeUndefined();
  });
});

describe('runSynthJob', () => {
  let workdir: string;

  beforeEach(() => {
    workdir = fs.mkdtempSync(path.join(os.tmpdir(), 'mw-synth-job-'));
  });
  afterEach(() => {
    fs.rmSync(workdir, { recursive: true, force: true });
  });

  interface Harness {
    deps: SynthJobDeps;
    commands: RecordedCommand[];
    uploads: Map<string, Buffer>;
    synthCalls: unknown[];
    stderr: string[];
  }

  function harness(overrides: {
    env?: Record<string, string>;
    synthExitCode?: number;
    checkoutFiles?: Record<string, string>;
    failCommand?: string;
  } = {}): Harness {
    const commands: RecordedCommand[] = [];
    const uploads = new Map<string, Buffer>();
    const synthCalls: unknown[] = [];
    const stderr: string[] = [];
    const deps: SynthJobDeps = {
      env: overrides.env ?? ENV,
      workdir,
      run: async (file, args, options) => {
        commands.push({ file, args: [...args], options });
        if (overrides.failCommand && `${file} ${args.join(' ')}`.includes(overrides.failCommand)) {
          throw new Error(`${file} exited 1`);
        }
        // Simulate the checkout landing files in the source dir.
        if (file === 'git' && args.includes('checkout')) {
          for (const [name, content] of Object.entries(overrides.checkoutFiles ?? {})) {
            const target = path.join(workdir, 'src', name);
            fs.mkdirSync(path.dirname(target), { recursive: true });
            fs.writeFileSync(target, content);
          }
        }
        // Simulate tar producing the archive.
        if (file === 'tar') {
          fs.writeFileSync(path.join(workdir, 'source.tar.gz'), 'tarball-bytes');
        }
      },
      putObject: async (key, body) => {
        uploads.set(key, Buffer.isBuffer(body) ? body : Buffer.from(body));
      },
      synth: (options) => {
        synthCalls.push(options);
        if ((overrides.synthExitCode ?? 0) === 0 && options.out) {
          fs.writeFileSync(options.out, '{"schemaVersion":1}');
        }
        return overrides.synthExitCode ?? 0;
      },
      stderr: (text) => stderr.push(text),
    };
    return { deps, commands, uploads, synthCalls, stderr };
  }

  it('clones with the deploy key against pinned host keys, checks out the sha', async () => {
    const h = harness({ checkoutFiles: { 'package.json': '{}', 'package-lock.json': '{}' } });
    const code = await runSynthJob(h.deps);
    expect(code).toBe(0);

    const keyFile = path.join(workdir, 'deploy-key');
    const knownHosts = path.join(workdir, 'known_hosts');
    expect(fs.readFileSync(keyFile, 'utf8')).toBe(ENV.MILLWRIGHT_DEPLOY_KEY);
    expect(fs.statSync(keyFile).mode & 0o777).toBe(0o600);
    expect(fs.readFileSync(knownHosts, 'utf8')).toBe(ENV.MILLWRIGHT_HOST_KEYS);

    const gitCalls = h.commands.filter((c) => c.file === 'git');
    expect(gitCalls.map((c) => c.args.join(' '))).toEqual([
      'init --quiet .',
      'remote add origin git@github.com:octocat/app.git',
      `fetch --quiet --no-tags --depth 1 origin ${ENV.MILLWRIGHT_SHA}`,
      `-c advice.detachedHead=false checkout --quiet --detach ${ENV.MILLWRIGHT_SHA}`,
    ]);
    for (const call of gitCalls) {
      const ssh = call.options.env?.GIT_SSH_COMMAND ?? '';
      expect(ssh).toContain(`-i ${keyFile}`);
      expect(ssh).toContain(`-o UserKnownHostsFile=${knownHosts}`);
      expect(ssh).toContain('-o StrictHostKeyChecking=yes');
      expect(ssh).toContain('-o IdentitiesOnly=yes');
    }
  });

  it('fetches the PR head from the base repo namespace for PR runs — one extra fetch, no fork remote', async () => {
    const h = harness({
      env: { ...ENV, MILLWRIGHT_REF: 'refs/pull/17/head' },
      checkoutFiles: { 'package.json': '{}', 'package-lock.json': '{}' },
    });
    await runSynthJob(h.deps);
    const fetches = h.commands.filter((c) => c.file === 'git' && c.args.includes('fetch'));
    expect(fetches).toHaveLength(2);
    expect(fetches[0].args.join(' ')).toContain('+refs/pull/17/head');
    expect(fetches[1].args.join(' ')).toContain(ENV.MILLWRIGHT_SHA);
    const remotes = h.commands.filter((c) => c.file === 'git' && c.args[0] === 'remote');
    expect(remotes).toHaveLength(1);
  });

  it('packages source.tar.gz from the pristine checkout, before dependency install', async () => {
    const h = harness({ checkoutFiles: { 'package.json': '{}', 'package-lock.json': '{}' } });
    await runSynthJob(h.deps);
    const order = h.commands.map((c) => `${c.file} ${c.args[0] ?? ''}`.trim());
    const tarIndex = order.findIndex((c) => c.startsWith('tar'));
    const installIndex = order.findIndex((c) => c === 'npm ci');
    expect(tarIndex).toBeGreaterThan(-1);
    expect(installIndex).toBeGreaterThan(-1);
    expect(tarIndex).toBeLessThan(installIndex);
    const tar = h.commands[tarIndex];
    expect(tar.args).toContain('--exclude=.git');
  });

  it('runs synth in-process with identity, ceiling and lint inputs, then uploads both objects', async () => {
    const h = harness({
      env: {
        ...ENV,
        MILLWRIGHT_REPO_CONFIG: '{"secretsAllowedRefs":["main"]}',
        MILLWRIGHT_POLL_CADENCE_MINUTES: '1',
      },
      checkoutFiles: { 'package.json': '{}', 'package-lock.json': '{}' },
    });
    const code = await runSynthJob(h.deps);
    expect(code).toBe(0);

    expect(h.synthCalls).toHaveLength(1);
    expect(h.synthCalls[0]).toMatchObject({
      cwd: path.join(workdir, 'src'),
      repo: 'octocat/app',
      commit: ENV.MILLWRIGHT_SHA,
      ref: 'main',
      schemaCeiling: 1,
      pollCadence: 1,
      secretsAllowedRefs: ['main'],
    });

    expect([...h.uploads.keys()].sort()).toEqual([
      `${ENV.MILLWRIGHT_DEST_PREFIX}${MODEL_OBJECT}`,
      `${ENV.MILLWRIGHT_DEST_PREFIX}${SOURCE_OBJECT}`,
    ]);
    expect(h.uploads.get(`${ENV.MILLWRIGHT_DEST_PREFIX}${MODEL_OBJECT}`)?.toString()).toContain(
      'schemaVersion',
    );
  });

  it('skips dependency install when the checkout has no package.json', async () => {
    const h = harness({ checkoutFiles: { 'millwright/workflows.ts': 'export default 0' } });
    const code = await runSynthJob(h.deps);
    expect(code).toBe(0);
    expect(h.commands.some((c) => c.file === 'npm')).toBe(false);
  });

  it('surfaces the no-lockfile warning on stderr', async () => {
    const h = harness({ checkoutFiles: { 'package.json': '{}' } });
    await runSynthJob(h.deps);
    expect(h.stderr.join('')).toMatch(/lockfile/);
    expect(h.commands.some((c) => c.file === 'npm' && c.args[0] === 'install')).toBe(true);
  });

  it('a failed synth writes synth-error.json to the in/ prefix and exits 1', async () => {
    const h = harness({
      synthExitCode: 1,
      checkoutFiles: { 'package.json': '{}', 'package-lock.json': '{}' },
    });
    const code = await runSynthJob(h.deps);
    expect(code).toBe(1);
    const errorKey = `${ENV.MILLWRIGHT_DEST_PREFIX}${SYNTH_ERROR_OBJECT}`;
    expect([...h.uploads.keys()]).toEqual([errorKey]);
    const parsed = JSON.parse(h.uploads.get(errorKey)!.toString());
    expect(parsed.message).toMatch(/synth/i);
  });

  it('a failed clone also lands synth-error.json, best-effort', async () => {
    const h = harness({ failCommand: 'fetch' });
    const code = await runSynthJob(h.deps);
    expect(code).toBe(1);
    const errorKey = `${ENV.MILLWRIGHT_DEST_PREFIX}${SYNTH_ERROR_OBJECT}`;
    const parsed = JSON.parse(h.uploads.get(errorKey)!.toString());
    expect(parsed.message).toContain('exited 1');
  });

  it('never uploads a model when synth fails', async () => {
    const h = harness({
      synthExitCode: 1,
      checkoutFiles: { 'package.json': '{}', 'package-lock.json': '{}' },
    });
    await runSynthJob(h.deps);
    expect([...h.uploads.keys()].some((k) => k.endsWith(MODEL_OBJECT))).toBe(false);
  });
});
