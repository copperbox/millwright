import { parseGithubCredentials } from '@copperbox/millwright-state';
import { describe, expect, it } from 'vitest';
import { CommandError } from '../src/config-plane';
import { FetchLike } from '../src/github/rest';
import { hostKeysParameterValue, refreshHostKeys, setup, SetupDeps } from '../src/setup';
import { FakeSsm } from './fake-ssm';

const META = { ssh_keys: ['ssh-ed25519 AAAmeta', 'ecdsa-sha2-nistp256 BBBmeta'] };

function metaAndUserFetch(): FetchLike {
  return async (url) => {
    if (url.endsWith('/meta')) {
      return { ok: true, status: 200, text: async () => JSON.stringify(META) };
    }
    if (url.endsWith('/user')) {
      return { ok: true, status: 200, text: async () => JSON.stringify({ login: 'octocat' }) };
    }
    throw new Error(`unexpected fetch ${url}`);
  };
}

function makeDeps(ssm: FakeSsm, overrides: Partial<SetupDeps> = {}): SetupDeps & { lines: string[] } {
  const lines: string[] = [];
  return {
    ssm,
    fetchLike: metaAndUserFetch(),
    output: (line) => lines.push(line),
    promptSecret: async () => 'github_pat_TEST',
    manifestFlow: async () => ({
      appId: 42,
      slug: 'millwright-prod',
      privateKeyPem: 'PEM-CONTENT',
      htmlUrl: 'https://github.com/apps/millwright-prod',
    }),
    lines,
    ...overrides,
  };
}

describe('setup (App manifest flow)', () => {
  it('stores App credentials under the CMK and seeds host-key pins', async () => {
    const ssm = new FakeSsm();
    ssm.setManifest('prod');
    const deps = makeDeps(ssm);
    await setup(deps, {});

    const creds = ssm.parameters.get('/millwright/prod/github/app')!;
    expect(creds.Type).toBe('SecureString');
    expect(creds.KeyId).toBe('arn:aws:kms:us-east-1:123456789012:key/test-cmk');
    expect(parseGithubCredentials(creds.Value)).toEqual({
      mode: 'app',
      appId: 42,
      slug: 'millwright-prod',
      privateKeyPem: 'PEM-CONTENT',
    });

    const pins = ssm.parameters.get('/millwright/prod/github/host-keys')!;
    expect(pins.Type).toBe('String');
    expect(pins.Value).toBe('github.com ssh-ed25519 AAAmeta\ngithub.com ecdsa-sha2-nistp256 BBBmeta');

    expect(deps.lines.join('\n')).toContain('installations/new');
    expect(deps.lines.join('\n')).toContain('12,500');
  });

  it('refuses to replace existing credentials without --force', async () => {
    const ssm = new FakeSsm();
    ssm.setManifest('prod');
    ssm.set('/millwright/prod/github/app', '{"mode":"pat","token":"x"}', 'SecureString');
    await expect(setup(makeDeps(ssm), {})).rejects.toThrow(CommandError);
    await expect(setup(makeDeps(ssm), { force: true })).resolves.toBeUndefined();
  });

  it('fails loudly when the manifest predates the config CMK', async () => {
    const ssm = new FakeSsm();
    ssm.set('/millwright/prod/manifest', JSON.stringify({ deploymentName: 'prod', version: '0', schemaVersion: 1 }));
    await expect(setup(makeDeps(ssm), {})).rejects.toThrow(/configKeyArn/);
  });
});

describe('setup --pat', () => {
  it('verifies and stores the fine-grained PAT, and still seeds host keys', async () => {
    const ssm = new FakeSsm();
    ssm.setManifest('prod');
    const deps = makeDeps(ssm);
    await setup(deps, { pat: true });

    const creds = ssm.parameters.get('/millwright/prod/github/app')!;
    expect(creds.Type).toBe('SecureString');
    expect(parseGithubCredentials(creds.Value)).toEqual({ mode: 'pat', token: 'github_pat_TEST' });
    expect(ssm.parameters.has('/millwright/prod/github/host-keys')).toBe(true);
    // Status-mode reporting keeps the same context names for branch protection.
    expect(deps.lines.join('\n')).toContain('commit statuses');
    expect(deps.lines.join('\n')).toContain('octocat');
  });

  it('aborts on an empty token', async () => {
    const ssm = new FakeSsm();
    ssm.setManifest('prod');
    const deps = makeDeps(ssm, { promptSecret: async () => '  ' });
    await expect(setup(deps, { pat: true })).rejects.toThrow(/no token/);
    expect(ssm.parameters.has('/millwright/prod/github/app')).toBe(false);
  });
});

describe('hostKeysParameterValue', () => {
  it('prefixes each /meta key with the host for known_hosts-style pins', () => {
    expect(hostKeysParameterValue(['ssh-ed25519 K1'])).toBe('github.com ssh-ed25519 K1');
  });
});

describe('refresh-host-keys', () => {
  it('re-pins from /meta and notes the poller picks pins up next tick', async () => {
    const ssm = new FakeSsm();
    ssm.setManifest('prod');
    ssm.set('/millwright/prod/github/host-keys', 'github.com ssh-ed25519 STALE');
    const deps = makeDeps(ssm);
    await refreshHostKeys(deps, {});
    expect(ssm.parameters.get('/millwright/prod/github/host-keys')!.Value).toBe(
      'github.com ssh-ed25519 AAAmeta\ngithub.com ecdsa-sha2-nistp256 BBBmeta',
    );
    expect(deps.lines[0]).toMatch(/^Re-pinned 2 GitHub SSH host keys .*next tick\.$/);
  });

  it('says so when the pins already match /meta', async () => {
    const ssm = new FakeSsm();
    ssm.setManifest('prod');
    const deps = makeDeps(ssm);
    await refreshHostKeys(deps, {});
    expect(deps.lines[0]).toMatch(/^Pinned 2 GitHub SSH host keys/);
    deps.lines.length = 0;
    await refreshHostKeys(deps, {});
    expect(deps.lines[0]).toMatch(/^Host keys unchanged — 2 pins/);
  });
});
