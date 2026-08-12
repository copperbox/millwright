import { describe, expect, it } from 'vitest';
import {
  GithubApiError,
  convertAppManifestCode,
  createDeployKey,
  createInstallationToken,
  deleteDeployKey,
  getGithubMeta,
  getRepoInstallationId,
  getTokenIdentity,
  listDeployKeys,
} from '../src/github/rest';

interface Recorded {
  url: string;
  method: string;
  headers: Record<string, string>;
  body?: string;
}

function fakeFetch(responses: Array<{ status: number; json?: unknown; text?: string }>) {
  const calls: Recorded[] = [];
  const fetchLike = async (url: string, init?: any) => {
    calls.push({
      url,
      method: init?.method ?? 'GET',
      headers: init?.headers ?? {},
      body: init?.body,
    });
    const next = responses.shift() ?? { status: 500, text: 'fixture exhausted' };
    return {
      ok: next.status >= 200 && next.status < 300,
      status: next.status,
      text: async () => (next.json !== undefined ? JSON.stringify(next.json) : next.text ?? ''),
    };
  };
  return { calls, fetchLike };
}

describe('github REST helpers', () => {
  it('getGithubMeta returns the SSH host keys', async () => {
    const { calls, fetchLike } = fakeFetch([
      { status: 200, json: { ssh_keys: ['ssh-ed25519 AAA', 'ssh-rsa BBB'] } },
    ]);
    await expect(getGithubMeta(fetchLike)).resolves.toEqual({
      sshKeys: ['ssh-ed25519 AAA', 'ssh-rsa BBB'],
    });
    expect(calls[0].url).toBe('https://api.github.com/meta');
    expect(calls[0].headers['X-GitHub-Api-Version']).toBe('2022-11-28');
    expect(calls[0].headers['User-Agent']).toContain('millwright');
    expect(calls[0].headers.Authorization).toBeUndefined();
  });

  it('convertAppManifestCode exchanges the temporary code for App credentials', async () => {
    const { calls, fetchLike } = fakeFetch([
      {
        status: 201,
        json: { id: 42, slug: 'millwright-prod', pem: 'PEMPEM', html_url: 'https://github.com/apps/millwright-prod' },
      },
    ]);
    await expect(convertAppManifestCode(fetchLike, 'tempcode')).resolves.toEqual({
      appId: 42,
      slug: 'millwright-prod',
      privateKeyPem: 'PEMPEM',
      htmlUrl: 'https://github.com/apps/millwright-prod',
    });
    expect(calls[0]).toMatchObject({
      url: 'https://api.github.com/app-manifests/tempcode/conversions',
      method: 'POST',
    });
  });

  it('getRepoInstallationId resolves the installation, undefined when not installed', async () => {
    const { calls, fetchLike } = fakeFetch([
      { status: 200, json: { id: 77 } },
      { status: 404, json: { message: 'Not Found' } },
    ]);
    await expect(getRepoInstallationId(fetchLike, 'jwt-1', 'acme/api')).resolves.toBe(77);
    await expect(getRepoInstallationId(fetchLike, 'jwt-1', 'acme/api')).resolves.toBeUndefined();
    expect(calls[0].url).toBe('https://api.github.com/repos/acme/api/installation');
    expect(calls[0].headers.Authorization).toBe('Bearer jwt-1');
  });

  it('createInstallationToken mints a token (in memory only — never stored)', async () => {
    const { calls, fetchLike } = fakeFetch([
      { status: 201, json: { token: 'ghs_abc', expires_at: '2026-08-12T06:00:00Z' } },
    ]);
    await expect(createInstallationToken(fetchLike, 'jwt-1', 77)).resolves.toEqual({
      token: 'ghs_abc',
      expiresAt: '2026-08-12T06:00:00Z',
    });
    expect(calls[0]).toMatchObject({
      url: 'https://api.github.com/app/installations/77/access_tokens',
      method: 'POST',
    });
  });

  it('deploy-key CRUD hits the repo keys endpoints read_only', async () => {
    const { calls, fetchLike } = fakeFetch([
      { status: 201, json: { id: 9 } },
      { status: 200, json: [{ id: 9, title: 'millwright/prod', key: 'ssh-ed25519 AAA' }] },
      { status: 204 },
    ]);
    await expect(
      createDeployKey(fetchLike, 'ghs_abc', 'acme/api', {
        title: 'millwright/prod',
        key: 'ssh-ed25519 AAA c',
      }),
    ).resolves.toEqual({ id: 9 });
    expect(calls[0].url).toBe('https://api.github.com/repos/acme/api/keys');
    expect(JSON.parse(calls[0].body!)).toEqual({
      title: 'millwright/prod',
      key: 'ssh-ed25519 AAA c',
      read_only: true,
    });

    await expect(listDeployKeys(fetchLike, 'ghs_abc', 'acme/api')).resolves.toEqual([
      { id: 9, title: 'millwright/prod', key: 'ssh-ed25519 AAA' },
    ]);
    await deleteDeployKey(fetchLike, 'ghs_abc', 'acme/api', 9);
    expect(calls[2]).toMatchObject({
      url: 'https://api.github.com/repos/acme/api/keys/9',
      method: 'DELETE',
    });
  });

  it('getTokenIdentity validates a PAT and names its owner', async () => {
    const { calls, fetchLike } = fakeFetch([{ status: 200, json: { login: 'octocat' } }]);
    await expect(getTokenIdentity(fetchLike, 'github_pat_x')).resolves.toEqual({
      login: 'octocat',
    });
    expect(calls[0].headers.Authorization).toBe('Bearer github_pat_x');
  });

  it('raises GithubApiError with status and GitHub message on failures', async () => {
    const { fetchLike } = fakeFetch([
      { status: 403, json: { message: 'Resource not accessible by integration' } },
    ]);
    const err = await getGithubMeta(fetchLike).catch((e) => e);
    expect(err).toBeInstanceOf(GithubApiError);
    expect(err.status).toBe(403);
    expect(err.message).toContain('Resource not accessible by integration');
    expect(err.message).toContain('/meta');
  });
});
