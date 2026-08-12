import { generateKeyPairSync } from 'node:crypto';
import { PutEventsCommand } from '@aws-sdk/client-eventbridge';
import { serializeGithubCredentials, serializeRepoConfig, defaultRepoConfig } from '@copperbox/millwright-state';
import { describe, expect, it } from 'vitest';
import { CommandError } from '../src/config-plane';
import { DefaultBranchHead } from '../src/git/ls-refs';
import { FetchLike } from '../src/github/rest';
import { repoAdd, repoList, repoRemove, repoUpdate, RepoDeps, ResolveHeadOptions } from '../src/repo';
import { FakeSsm } from './fake-ssm';

const SHA = 'c0ffee0000000000000000000000000000000000';
const REPO = 'acme/api';

const APP_KEY = generateKeyPairSync('rsa', { modulusLength: 2048 })
  .privateKey.export({ type: 'pkcs1', format: 'pem' })
  .toString();

const APP_CREDS = serializeGithubCredentials({
  mode: 'app',
  appId: 42,
  slug: 'millwright-prod',
  privateKeyPem: APP_KEY,
});

interface GithubFixture {
  installationId?: number;
  keyCreateStatus?: number;
  existingKeys?: Array<{ id: number; title: string; key: string }>;
}

function githubFetch(fixture: GithubFixture, calls: Array<{ url: string; method: string; body?: string }>): FetchLike {
  return async (url, init) => {
    calls.push({ url, method: init?.method ?? 'GET', body: init?.body });
    const respond = (status: number, json: unknown) => ({
      ok: status < 300,
      status,
      text: async () => JSON.stringify(json),
    });
    if (url.endsWith(`/repos/${REPO}/installation`)) {
      return fixture.installationId
        ? respond(200, { id: fixture.installationId })
        : respond(404, { message: 'Not Found' });
    }
    if (url.includes('/access_tokens')) {
      return respond(201, { token: 'ghs_mem_only', expires_at: '2026-08-12T07:00:00Z' });
    }
    if (url.endsWith(`/repos/${REPO}/keys`) && init?.method === 'POST') {
      const status = fixture.keyCreateStatus ?? 201;
      return status < 300 ? respond(status, { id: 900 }) : respond(status, { message: 'nope' });
    }
    if (url.endsWith(`/repos/${REPO}/keys`)) {
      return respond(200, fixture.existingKeys ?? []);
    }
    if (/\/keys\/\d+$/.test(url) && init?.method === 'DELETE') {
      return respond(204, undefined);
    }
    throw new Error(`unexpected fetch ${init?.method ?? 'GET'} ${url}`);
  };
}

function prodSsm(extraResources: Record<string, unknown> = { eventBus: 'millwright-prod-bus' }): FakeSsm {
  const ssm = new FakeSsm();
  ssm.setManifest('prod', extraResources);
  ssm.set('/millwright/prod/github/app', APP_CREDS, 'SecureString');
  ssm.set('/millwright/prod/github/host-keys', `github.com ssh-ed25519 ${Buffer.from('pin').toString('base64')}`);
  return ssm;
}

interface DepsExtras {
  head?: DefaultBranchHead;
  headFailures?: number;
  github?: GithubFixture;
}

function makeDeps(ssm: FakeSsm, extras: DepsExtras = {}) {
  const lines: string[] = [];
  const githubCalls: Array<{ url: string; method: string; body?: string }> = [];
  const events: any[] = [];
  const resolveHeadCalls: ResolveHeadOptions[] = [];
  const operatorWaits: string[] = [];
  let failures = extras.headFailures ?? 0;
  const deps: RepoDeps = {
    ssm,
    fetchLike: githubFetch(extras.github ?? { installationId: 77 }, githubCalls),
    eventBridge: {
      send: async (command: unknown) => {
        events.push((command as PutEventsCommand).input);
        return { FailedEntryCount: 0 };
      },
    },
    output: (line) => lines.push(line),
    waitForOperator: async (message) => {
      operatorWaits.push(message);
    },
    generateKey: (comment) => ({
      publicKey: `ssh-ed25519 PUBBLOB ${comment}`,
      privateKey: '-----BEGIN OPENSSH PRIVATE KEY-----\nFAKE\n-----END OPENSSH PRIVATE KEY-----\n',
    }),
    resolveHead: async (options) => {
      resolveHeadCalls.push(options);
      if (failures > 0) {
        failures--;
        throw new Error('auth rejected');
      }
      return (
        extras.head ?? { branch: 'main', ref: 'refs/heads/main', sha: SHA, empty: false }
      );
    },
    sleep: async () => {},
  };
  return { deps, lines, githubCalls, events, resolveHeadCalls, operatorWaits };
}

describe('repo add', () => {
  it('onboards end-to-end: key installed, params written, ls-refs verified, bootstrap emitted', async () => {
    const ssm = prodSsm();
    const { deps, lines, githubCalls, events, resolveHeadCalls, operatorWaits } = makeDeps(ssm);
    await repoAdd(deps, { repo: REPO, secretsRefs: ['main', 'release/*'] });

    // Deploy key installed through the App's Administration permission.
    const keyPost = githubCalls.find((c) => c.method === 'POST' && c.url.endsWith('/keys'))!;
    expect(JSON.parse(keyPost.body!)).toEqual({
      title: 'millwright/prod',
      key: `ssh-ed25519 PUBBLOB millwright/prod ${REPO}`,
      read_only: true,
    });
    expect(operatorWaits).toEqual([]);

    // Both parameters written; the key under the CMK, before the config.
    const keyParam = ssm.parameters.get(`/millwright/prod/repos/${REPO}/deploy-key`)!;
    expect(keyParam.Type).toBe('SecureString');
    expect(keyParam.KeyId).toContain('key/test-cmk');
    expect(ssm.puts.map((p) => p.Name)).toEqual([
      `/millwright/prod/repos/${REPO}/deploy-key`,
      `/millwright/prod/repos/${REPO}/config`,
    ]);
    const config = JSON.parse(ssm.parameters.get(`/millwright/prod/repos/${REPO}/config`)!.Value);
    expect(config).toEqual({
      secretsAllowedRefs: ['main', 'release/*'],
      prPolling: true,
      forkPrPolicy: 'off',
      ecrPullRepos: [],
    });

    // ls-refs ran with the fresh key against the pinned host keys.
    expect(resolveHeadCalls).toHaveLength(1);
    expect(resolveHeadCalls[0].repo).toBe(REPO);
    expect(resolveHeadCalls[0].privateKey).toContain('OPENSSH PRIVATE KEY');
    expect(resolveHeadCalls[0].hostKeyPins).toHaveLength(1);

    // Bootstrap event: source millwright.cli, kind bootstrap, head sha.
    expect(events).toHaveLength(1);
    const entry = events[0].Entries[0];
    expect(entry.EventBusName).toBe('millwright-prod-bus');
    expect(entry.Source).toBe('millwright.cli');
    expect(entry.DetailType).toBe('bootstrap');
    expect(JSON.parse(entry.Detail)).toEqual({
      repo: REPO,
      ref: 'refs/heads/main',
      sha: SHA,
      kind: 'bootstrap',
    });
    expect(lines.join('\n')).toContain('millwright / synth');
  });

  it('retries the key check while GitHub propagates the key', async () => {
    const { deps, resolveHeadCalls, events } = makeDeps(prodSsm(), { headFailures: 2 });
    await repoAdd(deps, { repo: REPO });
    expect(resolveHeadCalls).toHaveLength(3);
    expect(events).toHaveLength(1);
  });

  it('fails after exhausting key-check attempts', async () => {
    const { deps, events } = makeDeps(prodSsm(), { headFailures: 3 });
    await expect(repoAdd(deps, { repo: REPO })).rejects.toThrow(/could not read/);
    expect(events).toHaveLength(0);
  });

  it('falls back to a manual key add when the App is not installed on the repo', async () => {
    const { deps, lines, operatorWaits, events } = makeDeps(prodSsm(), {
      github: { installationId: undefined },
    });
    await repoAdd(deps, { repo: REPO });
    expect(operatorWaits).toHaveLength(1);
    expect(lines.join('\n')).toContain(`https://github.com/${REPO}/settings/keys`);
    expect(lines.join('\n')).toContain('ssh-ed25519 PUBBLOB');
    expect(events).toHaveLength(1);
  });

  it('falls back to manual add when the API refuses the install', async () => {
    const { deps, operatorWaits } = makeDeps(prodSsm(), {
      github: { installationId: 77, keyCreateStatus: 403 },
    });
    await repoAdd(deps, { repo: REPO });
    expect(operatorWaits).toHaveLength(1);
  });

  it('prints the first-push note instead of emitting an event for an empty repo', async () => {
    const { deps, lines, events } = makeDeps(prodSsm(), {
      head: { branch: 'main', ref: 'refs/heads/main', empty: true },
    });
    await repoAdd(deps, { repo: REPO });
    expect(events).toHaveLength(0);
    expect(lines.join('\n')).toContain('first push');
    // The repo is still fully configured.
    expect(deps.ssm as FakeSsm).toBeTruthy();
  });

  it('skips the event with a note when the manifest names no bus yet', async () => {
    const { deps, lines, events } = makeDeps(prodSsm({}));
    await repoAdd(deps, { repo: REPO });
    expect(events).toHaveLength(0);
    expect(lines.join('\n')).toContain('first tick');
  });

  it('requires setup to have run', async () => {
    const ssm = new FakeSsm();
    ssm.setManifest('prod');
    const { deps } = makeDeps(ssm);
    await expect(repoAdd(deps, { repo: REPO })).rejects.toThrow(/millwright setup/);
  });

  it('refuses a second add and points at repo update', async () => {
    const ssm = prodSsm();
    ssm.set(`/millwright/prod/repos/${REPO}/config`, serializeRepoConfig(defaultRepoConfig()));
    const { deps } = makeDeps(ssm);
    await expect(repoAdd(deps, { repo: REPO })).rejects.toThrow(/repo update/);
  });

  it('rejects malformed repo names', async () => {
    const { deps } = makeDeps(prodSsm());
    await expect(repoAdd(deps, { repo: 'not-a-repo' })).rejects.toThrow(/owner\/repo/);
  });

  it('works in PAT mode using the PAT for the key install', async () => {
    const ssm = prodSsm();
    ssm.set(
      '/millwright/prod/github/app',
      serializeGithubCredentials({ mode: 'pat', token: 'github_pat_X' }),
      'SecureString',
    );
    const { deps, githubCalls, operatorWaits } = makeDeps(ssm);
    await repoAdd(deps, { repo: REPO });
    expect(operatorWaits).toEqual([]);
    const keyPost = githubCalls.find((c) => c.method === 'POST' && c.url.endsWith('/keys'))!;
    expect(keyPost).toBeDefined();
    // No installation endpoints in PAT mode.
    expect(githubCalls.some((c) => c.url.includes('/installation'))).toBe(false);
  });
});

describe('repo update', () => {
  it('round-trips every flag', async () => {
    const ssm = prodSsm();
    ssm.set(`/millwright/prod/repos/${REPO}/config`, serializeRepoConfig(defaultRepoConfig()));
    const { deps } = makeDeps(ssm);

    await repoUpdate(deps, {
      repo: REPO,
      secretsRefs: ['main'],
      prPolling: false,
      forkPrs: 'on',
      ecrRepos: ['arn:aws:ecr:us-east-1:1:repository/x'],
    });
    let stored = JSON.parse(ssm.parameters.get(`/millwright/prod/repos/${REPO}/config`)!.Value);
    expect(stored).toEqual({
      secretsAllowedRefs: ['main'],
      prPolling: false,
      forkPrPolicy: 'on',
      ecrPullRepos: ['arn:aws:ecr:us-east-1:1:repository/x'],
    });

    // Unspecified flags keep their stored values.
    await repoUpdate(deps, { repo: REPO, forkPrs: 'off' });
    stored = JSON.parse(ssm.parameters.get(`/millwright/prod/repos/${REPO}/config`)!.Value);
    expect(stored).toEqual({
      secretsAllowedRefs: ['main'],
      prPolling: false,
      forkPrPolicy: 'off',
      ecrPullRepos: ['arn:aws:ecr:us-east-1:1:repository/x'],
    });
  });

  it('refuses to update a repo that was never added', async () => {
    const { deps } = makeDeps(prodSsm());
    await expect(repoUpdate(deps, { repo: REPO, forkPrs: 'on' })).rejects.toThrow(/repo add/);
  });
});

describe('repo list', () => {
  it('lists configured repos with their parsed config', async () => {
    const ssm = prodSsm();
    ssm.set(`/millwright/prod/repos/${REPO}/config`, serializeRepoConfig(defaultRepoConfig()));
    ssm.set(
      '/millwright/prod/repos/acme/web/config',
      serializeRepoConfig({ ...defaultRepoConfig(), forkPrPolicy: 'on' }),
    );
    // Deploy keys must not be mistaken for repos.
    ssm.set(`/millwright/prod/repos/${REPO}/deploy-key`, 'KEY', 'SecureString');
    const { deps, lines } = makeDeps(ssm);
    const entries = await repoList(deps);
    expect(entries.map((e) => e.repo)).toEqual(['acme/api', 'acme/web']);
    expect(entries[1].config.forkPrPolicy).toBe('on');
    expect(lines.some((l) => l.startsWith('acme/api'))).toBe(true);
  });

  it('says so when nothing is configured', async () => {
    const { deps, lines } = makeDeps(prodSsm());
    await expect(repoList(deps)).resolves.toEqual([]);
    expect(lines.join('\n')).toContain('No repos configured');
  });
});

describe('repo remove', () => {
  it('deletes config + key params and best-effort removes the GitHub key', async () => {
    const ssm = prodSsm();
    ssm.set(`/millwright/prod/repos/${REPO}/config`, serializeRepoConfig(defaultRepoConfig()));
    ssm.set(`/millwright/prod/repos/${REPO}/deploy-key`, 'KEY', 'SecureString');
    const { deps, githubCalls, lines } = makeDeps(ssm, {
      github: {
        installationId: 77,
        existingKeys: [
          { id: 5, title: 'someone-elses-key', key: 'ssh-rsa OTHER' },
          { id: 900, title: 'millwright/prod', key: 'ssh-ed25519 OURS' },
        ],
      },
    });
    await repoRemove(deps, { repo: REPO });

    expect(ssm.parameters.has(`/millwright/prod/repos/${REPO}/config`)).toBe(false);
    expect(ssm.parameters.has(`/millwright/prod/repos/${REPO}/deploy-key`)).toBe(false);
    const deletion = githubCalls.find((c) => c.method === 'DELETE')!;
    expect(deletion.url).toContain('/keys/900');
    expect(lines.join('\n')).toContain('Deleted');
  });

  it('still cleans the config plane when GitHub cleanup is impossible', async () => {
    const ssm = prodSsm();
    ssm.parameters.delete('/millwright/prod/github/app');
    ssm.set(`/millwright/prod/repos/${REPO}/config`, serializeRepoConfig(defaultRepoConfig()));
    ssm.set(`/millwright/prod/repos/${REPO}/deploy-key`, 'KEY', 'SecureString');
    const { deps } = makeDeps(ssm);
    await repoRemove(deps, { repo: REPO });
    expect(ssm.parameters.has(`/millwright/prod/repos/${REPO}/config`)).toBe(false);
  });

  it('errors when the repo was never configured', async () => {
    const { deps } = makeDeps(prodSsm());
    await expect(repoRemove(deps, { repo: REPO })).rejects.toThrow(CommandError);
  });
});
