/**
 * The thin GitHub REST slice millwright's onboarding needs (spec §13.1):
 * /meta host keys, the App-manifest conversion, installation lookup + token
 * minting, and deploy-key CRUD. Fetch is injectable so tests script it.
 *
 * Installation tokens minted here live in local variables only — never
 * written to SSM, DynamoDB, or disk (spec §13.1's in-memory-only rule).
 */

import { VERSION } from '../version';

export type FetchLike = (
  url: string,
  init?: {
    method?: string;
    headers?: Record<string, string>;
    body?: string;
  },
) => Promise<{ ok: boolean; status: number; text(): Promise<string> }>;

export class GithubApiError extends Error {
  readonly status: number;

  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

const BASE_URL = 'https://api.github.com';

async function request(
  fetchLike: FetchLike,
  method: string,
  path: string,
  options: { token?: string; body?: unknown } = {},
): Promise<{ status: number; json: unknown }> {
  const headers: Record<string, string> = {
    Accept: 'application/vnd.github+json',
    'X-GitHub-Api-Version': '2022-11-28',
    'User-Agent': `millwright-cli/${VERSION}`,
  };
  if (options.token) {
    headers.Authorization = `Bearer ${options.token}`;
  }
  if (options.body !== undefined) {
    headers['Content-Type'] = 'application/json';
  }
  const response = await fetchLike(`${BASE_URL}${path}`, {
    method,
    headers,
    ...(options.body !== undefined ? { body: JSON.stringify(options.body) } : {}),
  });
  const text = await response.text();
  let json: unknown;
  try {
    json = text ? JSON.parse(text) : undefined;
  } catch {
    json = undefined;
  }
  if (!response.ok) {
    const detail =
      json && typeof json === 'object' && typeof (json as { message?: unknown }).message === 'string'
        ? (json as { message: string }).message
        : text.slice(0, 200) || 'no response body';
    throw new GithubApiError(response.status, `GitHub ${method} ${path} failed (${response.status}): ${detail}`);
  }
  return { status: response.status, json };
}

export interface GithubMeta {
  readonly sshKeys: readonly string[];
}

/** GET /meta — the source of the SSH host-key pins (spec §6.1). */
export async function getGithubMeta(fetchLike: FetchLike): Promise<GithubMeta> {
  const { json } = await request(fetchLike, 'GET', '/meta');
  const sshKeys = (json as { ssh_keys?: unknown })?.ssh_keys;
  if (!Array.isArray(sshKeys) || sshKeys.some((key) => typeof key !== 'string')) {
    throw new GithubApiError(200, 'GitHub /meta returned no ssh_keys array');
  }
  return { sshKeys };
}

export interface ConvertedApp {
  readonly appId: number;
  readonly slug: string;
  readonly privateKeyPem: string;
  readonly htmlUrl: string;
}

/** POST /app-manifests/{code}/conversions — completes the manifest flow. */
export async function convertAppManifestCode(
  fetchLike: FetchLike,
  code: string,
): Promise<ConvertedApp> {
  const { json } = await request(
    fetchLike,
    'POST',
    `/app-manifests/${encodeURIComponent(code)}/conversions`,
  );
  const app = json as { id?: unknown; slug?: unknown; pem?: unknown; html_url?: unknown };
  if (typeof app?.id !== 'number' || typeof app.slug !== 'string' || typeof app.pem !== 'string') {
    throw new GithubApiError(201, 'manifest conversion response missing id/slug/pem');
  }
  return {
    appId: app.id,
    slug: app.slug,
    privateKeyPem: app.pem,
    htmlUrl: typeof app.html_url === 'string' ? app.html_url : `https://github.com/apps/${app.slug}`,
  };
}

/**
 * GET /repos/{owner}/{repo}/installation with an App JWT. Undefined when the
 * App is not installed on the repo (the caller falls back to manual add).
 */
export async function getRepoInstallationId(
  fetchLike: FetchLike,
  appJwt: string,
  repo: string,
): Promise<number | undefined> {
  try {
    const { json } = await request(fetchLike, 'GET', `/repos/${repo}/installation`, {
      token: appJwt,
    });
    const id = (json as { id?: unknown })?.id;
    return typeof id === 'number' ? id : undefined;
  } catch (err) {
    if (err instanceof GithubApiError && err.status === 404) {
      return undefined;
    }
    throw err;
  }
}

export interface InstallationToken {
  readonly token: string;
  readonly expiresAt: string;
}

/**
 * POST /app/installations/{id}/access_tokens. The result stays in memory for
 * the life of the command — persisting it anywhere is a spec violation.
 */
export async function createInstallationToken(
  fetchLike: FetchLike,
  appJwt: string,
  installationId: number,
): Promise<InstallationToken> {
  const { json } = await request(
    fetchLike,
    'POST',
    `/app/installations/${installationId}/access_tokens`,
    { token: appJwt },
  );
  const token = json as { token?: unknown; expires_at?: unknown };
  if (typeof token?.token !== 'string') {
    throw new GithubApiError(201, 'installation token response missing token');
  }
  return {
    token: token.token,
    expiresAt: typeof token.expires_at === 'string' ? token.expires_at : '',
  };
}

export interface DeployKeyRecord {
  readonly id: number;
  readonly title: string;
  readonly key: string;
}

/** POST /repos/{owner}/{repo}/keys — always read-only (spec §13.1). */
export async function createDeployKey(
  fetchLike: FetchLike,
  token: string,
  repo: string,
  options: { title: string; key: string },
): Promise<{ id: number }> {
  const { json } = await request(fetchLike, 'POST', `/repos/${repo}/keys`, {
    token,
    body: { title: options.title, key: options.key, read_only: true },
  });
  const id = (json as { id?: unknown })?.id;
  if (typeof id !== 'number') {
    throw new GithubApiError(201, 'deploy key creation response missing id');
  }
  return { id };
}

export async function listDeployKeys(
  fetchLike: FetchLike,
  token: string,
  repo: string,
): Promise<DeployKeyRecord[]> {
  const { json } = await request(fetchLike, 'GET', `/repos/${repo}/keys`, { token });
  if (!Array.isArray(json)) {
    return [];
  }
  return json
    .filter((entry) => typeof entry?.id === 'number')
    .map((entry) => ({
      id: entry.id as number,
      title: typeof entry.title === 'string' ? entry.title : '',
      key: typeof entry.key === 'string' ? entry.key : '',
    }));
}

export async function deleteDeployKey(
  fetchLike: FetchLike,
  token: string,
  repo: string,
  keyId: number,
): Promise<void> {
  await request(fetchLike, 'DELETE', `/repos/${repo}/keys/${keyId}`, { token });
}

/** GET /user — validates a PAT and names its owner for the setup summary. */
export async function getTokenIdentity(
  fetchLike: FetchLike,
  token: string,
): Promise<{ login: string }> {
  const { json } = await request(fetchLike, 'GET', '/user', { token });
  const login = (json as { login?: unknown })?.login;
  return { login: typeof login === 'string' ? login : 'unknown' };
}
