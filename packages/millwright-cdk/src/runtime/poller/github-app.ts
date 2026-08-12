import { createSign } from 'node:crypto';

/**
 * GitHub App installation tokens for tier-2 REST work (spec §13.1):
 * **minted on demand and cached in memory only, per consumer Lambda** — never
 * in DynamoDB, never as rotated secrets. The flow is the standard App
 * exchange: a short-lived RS256 App JWT signed with the PEM from the
 * `github/app` parameter, the repo's installation looked up once per owner,
 * and the installation token cached until shortly before its expiry.
 */

/** Parsed `github/app` SecureString payload (spec §9.2). */
export interface GithubAppConfig {
  readonly appId: string;
  readonly privateKey: string;
}

/** `{ "appId": …, "privateKey": "-----BEGIN…" }`; undefined when absent/unreadable. */
export function parseGithubAppParameter(value: string | undefined): GithubAppConfig | undefined {
  if (!value) {
    return undefined;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    return undefined;
  }
  if (typeof parsed !== 'object' || parsed === null) {
    return undefined;
  }
  const { appId, privateKey } = parsed as { appId?: unknown; privateKey?: unknown };
  let id: string | undefined;
  if (typeof appId === 'string' && appId) {
    id = appId;
  } else if (typeof appId === 'number') {
    id = String(appId);
  }
  return id && typeof privateKey === 'string' && privateKey ? { appId: id, privateKey } : undefined;
}

/** A tier-2 REST call failed; carries what the backoff logic wants to know. */
export class GithubApiError extends Error {
  constructor(
    message: string,
    /** HTTP status, when the request got that far. */
    readonly status?: number,
    /** Epoch ms the primary rate limit resets at, when GitHub said so. */
    readonly rateLimitResetMs?: number,
  ) {
    super(message);
  }
}

/** Epoch ms of `x-ratelimit-reset`, only when the limit is actually exhausted. */
export function rateLimitResetMs(headers: Headers): number | undefined {
  if (headers.get('x-ratelimit-remaining') !== '0') {
    return undefined;
  }
  const reset = Number(headers.get('x-ratelimit-reset'));
  return Number.isFinite(reset) && reset > 0 ? reset * 1000 : undefined;
}

export interface TokenMinter {
  /** True once the `github/app` parameter is present and parseable. */
  configured(): Promise<boolean>;
  /** An installation token authorized for the repo. Throws GithubApiError. */
  tokenFor(repo: string): Promise<string>;
}

/** The fetch slice the minter uses; tests inject a fake. */
export type HttpFetch = (url: string, init: RequestInit) => Promise<Response>;

/** App JWTs may live 10 minutes; sign for 9 and re-sign in the last minute. */
const JWT_TTL_SECONDS = 9 * 60;
const JWT_RENEW_MARGIN_MS = 60 * 1000;
/** Installation tokens live an hour; stop using them 5 minutes early. */
const TOKEN_RENEW_MARGIN_MS = 5 * 60 * 1000;

interface CachedToken {
  readonly value: string;
  readonly expiresAtMs: number;
}

export class InstallationTokenMinter implements TokenMinter {
  private app?: GithubAppConfig;
  private jwt?: { value: string; renewAtMs: number };
  /** Installation ids by repo owner — installations attach to accounts. */
  private readonly installations = new Map<string, Promise<number>>();
  private readonly tokens = new Map<number, Promise<CachedToken>>();

  constructor(
    /** Reads the `github/app` parameter; the result is cached while warm. */
    private readonly loadAppParameter: () => Promise<string | undefined>,
    private readonly fetchImpl: HttpFetch,
    private readonly now: () => number,
    private readonly baseUrl = 'https://api.github.com',
  ) {}

  async configured(): Promise<boolean> {
    // A missing parameter is re-checked every call so `millwright setup`
    // takes effect without a poller restart; a parsed one is kept while warm.
    this.app ??= parseGithubAppParameter(await this.loadAppParameter());
    return this.app !== undefined;
  }

  async tokenFor(repo: string): Promise<string> {
    if (!(await this.configured())) {
      throw new GithubApiError('github/app parameter missing — cannot mint installation token');
    }
    const owner = repo.split('/')[0];
    let installationId: number;
    try {
      installationId = await this.installation(owner, repo);
    } catch (err) {
      this.installations.delete(owner);
      throw this.evictOnAuthFailure(err);
    }
    const cached = this.tokens.get(installationId);
    if (cached) {
      try {
        const token = await cached;
        if (this.now() < token.expiresAtMs - TOKEN_RENEW_MARGIN_MS) {
          return token.value;
        }
      } catch {
        // A failed mint is never reused; fall through to a fresh one.
      }
      this.tokens.delete(installationId);
    }
    const minting = this.mint(installationId);
    this.tokens.set(installationId, minting);
    try {
      return (await minting).value;
    } catch (err) {
      this.tokens.delete(installationId);
      throw this.evictOnAuthFailure(err);
    }
  }

  /** A 401 means the cached App credentials went stale — re-read next tick. */
  private evictOnAuthFailure(err: unknown): unknown {
    if (err instanceof GithubApiError && err.status === 401) {
      this.app = undefined;
      this.jwt = undefined;
    }
    return err;
  }

  private installation(owner: string, repo: string): Promise<number> {
    let pending = this.installations.get(owner);
    if (!pending) {
      pending = (async () => {
        const body = await this.appRequest('GET', `/repos/${repo}/installation`, 200);
        const id = (body as { id?: unknown }).id;
        if (typeof id !== 'number') {
          throw new GithubApiError(`installation lookup for ${repo} returned no id`);
        }
        return id;
      })();
      this.installations.set(owner, pending);
    }
    return pending;
  }

  private async mint(installationId: number): Promise<CachedToken> {
    const body = await this.appRequest(
      'POST',
      `/app/installations/${installationId}/access_tokens`,
      201,
    );
    const { token, expires_at: expiresAt } = body as { token?: unknown; expires_at?: unknown };
    const expiresAtMs = typeof expiresAt === 'string' ? Date.parse(expiresAt) : NaN;
    if (typeof token !== 'string' || !token || Number.isNaN(expiresAtMs)) {
      throw new GithubApiError('access_tokens response missing token/expires_at');
    }
    return { value: token, expiresAtMs };
  }

  /** One App-JWT-authenticated exchange; anything unexpected is a GithubApiError. */
  private async appRequest(method: string, path: string, expectStatus: number): Promise<unknown> {
    let response: Response;
    try {
      response = await this.fetchImpl(`${this.baseUrl}${path}`, {
        method,
        headers: {
          accept: 'application/vnd.github+json',
          authorization: `Bearer ${this.appJwt()}`,
          'user-agent': 'millwright-poller',
        },
      });
    } catch (err) {
      throw new GithubApiError(`${method} ${path}: ${(err as Error).message}`);
    }
    if (response.status !== expectStatus) {
      throw new GithubApiError(
        `${method} ${path} returned ${response.status}`,
        response.status,
        rateLimitResetMs(response.headers),
      );
    }
    return response.json();
  }

  private appJwt(): string {
    const nowMs = this.now();
    if (!this.jwt || nowMs >= this.jwt.renewAtMs) {
      const nowSeconds = Math.floor(nowMs / 1000);
      // 60 s of backdating absorbs clock skew between Lambda and GitHub.
      const value = signAppJwt(this.app!, {
        iat: nowSeconds - 60,
        exp: nowSeconds + JWT_TTL_SECONDS,
        iss: this.app!.appId,
      });
      this.jwt = { value, renewAtMs: nowMs + (JWT_TTL_SECONDS * 1000 - JWT_RENEW_MARGIN_MS) };
    }
    return this.jwt.value;
  }
}

function signAppJwt(
  app: GithubAppConfig,
  claims: { iat: number; exp: number; iss: string },
): string {
  const encode = (part: object) => Buffer.from(JSON.stringify(part)).toString('base64url');
  const signingInput = `${encode({ alg: 'RS256', typ: 'JWT' })}.${encode(claims)}`;
  const signature = createSign('RSA-SHA256')
    .update(signingInput)
    .sign(app.privateKey)
    .toString('base64url');
  return `${signingInput}.${signature}`;
}
