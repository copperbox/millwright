/**
 * The GitHub credential parameter, `/millwright/<name>/github/app`
 * (spec §9.2, §13.1) — a SecureString under the deployment CMK. Written once
 * by `millwright setup`; read by the reporter and the tier-2 poller, which
 * mint installation tokens on demand and cache them in memory only.
 *
 * Two shapes behind one `mode` discriminator: the per-deployment GitHub App
 * from the manifest exchange, or the fine-grained-PAT fallback
 * (`setup --pat`), which reports commit statuses instead of check runs.
 */

export interface GithubAppCredentials {
  readonly mode: 'app';
  /** Numeric App id from the manifest conversion. */
  readonly appId: number;
  /** App slug — its URL name; `https://github.com/apps/<slug>`. */
  readonly slug: string;
  /** RSA private key PEM from the manifest conversion; signs App JWTs. */
  readonly privateKeyPem: string;
}

export interface GithubPatCredentials {
  readonly mode: 'pat';
  /** Fine-grained personal access token. */
  readonly token: string;
}

export type GithubCredentials = GithubAppCredentials | GithubPatCredentials;

export class GithubCredentialsFormatError extends Error {}

export function parseGithubCredentials(raw: string): GithubCredentials {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    throw new GithubCredentialsFormatError('GitHub credentials parameter is not valid JSON');
  }
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new GithubCredentialsFormatError('GitHub credentials must be a JSON object');
  }
  const record = value as Record<string, unknown>;
  if (record.mode === 'app') {
    if (typeof record.appId !== 'number' || !Number.isInteger(record.appId)) {
      throw new GithubCredentialsFormatError('App credentials need an integer appId');
    }
    if (typeof record.slug !== 'string' || !record.slug) {
      throw new GithubCredentialsFormatError('App credentials need a non-empty slug');
    }
    if (typeof record.privateKeyPem !== 'string' || !record.privateKeyPem) {
      throw new GithubCredentialsFormatError('App credentials need the private key PEM');
    }
    return {
      mode: 'app',
      appId: record.appId,
      slug: record.slug,
      privateKeyPem: record.privateKeyPem,
    };
  }
  if (record.mode === 'pat') {
    if (typeof record.token !== 'string' || !record.token) {
      throw new GithubCredentialsFormatError('PAT credentials need a non-empty token');
    }
    return { mode: 'pat', token: record.token };
  }
  throw new GithubCredentialsFormatError('GitHub credentials mode must be "app" or "pat"');
}

export function serializeGithubCredentials(credentials: GithubCredentials): string {
  return JSON.stringify(credentials, null, 2);
}
