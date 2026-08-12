import {
  DesiredCheckState,
  GithubCredentials,
  commitStatusForDesired,
} from '@copperbox/millwright-state';
import { createSign } from 'node:crypto';
import { CheckCoordinates, CheckPublisher, PublishFailure } from './reporter';

/**
 * The reporter's GitHub side (spec §13.1/§13.2): check-run create/update in
 * App mode, commit statuses in PAT mode, installation tokens minted on
 * demand and cached in memory only — never in DynamoDB, never in SSM.
 *
 * Fetch is injectable so tests script it; the handler passes global fetch.
 */

export interface ReporterFetchResponse {
  readonly ok: boolean;
  readonly status: number;
  readonly headers: { get(name: string): string | null };
  text(): Promise<string>;
}

export type ReporterFetch = (
  url: string,
  init?: { method?: string; headers?: Record<string, string>; body?: string },
) => Promise<ReporterFetchResponse>;

export interface GithubCheckPublisherOptions {
  readonly fetchLike: ReporterFetch;
  /** Reads and parses the SSM credentials parameter; result is cached. */
  readonly loadCredentials: () => Promise<GithubCredentials>;
  /** Injectable clock (epoch ms) for JWT claims and token expiry. */
  readonly now?: () => number;
}

const BASE_URL = 'https://api.github.com';

/** Refuse a cached token this close to expiry — a call may straddle it. */
const TOKEN_EXPIRY_SLACK_MS = 5 * 60 * 1000;

/**
 * App JWT per GitHub's App-auth contract: RS256, iat backdated 60 s against
 * clock drift, expiry well inside the 10-minute cap. (Deliberately the same
 * shape the CLI mints for onboarding; the CLI package is not a Lambda
 * dependency, so the 15 lines live here too.)
 */
function signAppJwt(appId: number, privateKeyPem: string, nowSeconds: number): string {
  const header = Buffer.from(JSON.stringify({ alg: 'RS256', typ: 'JWT' })).toString('base64url');
  const payload = Buffer.from(
    JSON.stringify({ iat: nowSeconds - 60, exp: nowSeconds + 540, iss: String(appId) }),
  ).toString('base64url');
  const signer = createSign('RSA-SHA256');
  signer.update(`${header}.${payload}`);
  const signature = signer.sign(privateKeyPem).toString('base64url');
  return `${header}.${payload}.${signature}`;
}

interface CachedToken {
  readonly token: string;
  readonly expiresAtMs: number;
}

export class GithubCheckPublisher implements CheckPublisher {
  private credentials?: Promise<GithubCredentials>;
  /** Per-repo installation tokens, warm-container-amortized (spec §13.1). */
  private readonly tokens = new Map<string, CachedToken>();
  private readonly now: () => number;

  constructor(private readonly options: GithubCheckPublisherOptions) {
    this.now = options.now ?? Date.now;
  }

  async publish(
    coords: CheckCoordinates,
    desired: DesiredCheckState,
    checkRunId?: number,
  ): Promise<{ checkRunId?: number }> {
    const credentials = await this.loadCredentials();
    if (credentials.mode === 'pat') {
      await this.postCommitStatus(credentials.token, coords, desired);
      return {};
    }
    const token = await this.installationToken(credentials.appId, credentials.privateKeyPem, coords.repo);
    return { checkRunId: await this.upsertCheckRun(token, coords, desired, checkRunId) };
  }

  private loadCredentials(): Promise<GithubCredentials> {
    if (!this.credentials) {
      this.credentials = this.options.loadCredentials().catch((err) => {
        // Never cache a failed read — the next attempt retries it.
        this.credentials = undefined;
        throw err;
      });
    }
    return this.credentials;
  }

  private async installationToken(
    appId: number,
    privateKeyPem: string,
    repo: string,
  ): Promise<string> {
    const cached = this.tokens.get(repo);
    if (cached && cached.expiresAtMs - TOKEN_EXPIRY_SLACK_MS > this.now()) {
      return cached.token;
    }
    const jwt = signAppJwt(appId, privateKeyPem, Math.floor(this.now() / 1000));
    const installation = (await this.request('GET', `/repos/${repo}/installation`, jwt)) as {
      id?: unknown;
    };
    if (typeof installation?.id !== 'number') {
      throw new PublishFailure(`GitHub App is not installed on ${repo}`);
    }
    const minted = (await this.request(
      'POST',
      `/app/installations/${installation.id}/access_tokens`,
      jwt,
    )) as { token?: unknown; expires_at?: unknown };
    if (typeof minted?.token !== 'string' || typeof minted.expires_at !== 'string') {
      throw new PublishFailure('installation token response missing token/expires_at');
    }
    this.tokens.set(repo, { token: minted.token, expiresAtMs: Date.parse(minted.expires_at) });
    return minted.token;
  }

  private async upsertCheckRun(
    token: string,
    coords: CheckCoordinates,
    desired: DesiredCheckState,
    checkRunId?: number,
  ): Promise<number | undefined> {
    const body = {
      name: coords.context,
      status: desired.status,
      ...(desired.conclusion !== undefined ? { conclusion: desired.conclusion } : {}),
      ...(desired.detailsUrl !== undefined ? { details_url: desired.detailsUrl } : {}),
      output: { title: desired.title, summary: desired.summary },
    };
    if (checkRunId !== undefined) {
      try {
        const updated = (await this.request(
          'PATCH',
          `/repos/${coords.repo}/check-runs/${checkRunId}`,
          token,
          body,
        )) as { id?: unknown };
        return typeof updated?.id === 'number' ? updated.id : checkRunId;
      } catch (err) {
        // The stored run vanished (retention, crash-window duplicate that
        // lost a race): mint a fresh one — duplicates are benign (§13.2).
        if (!(err instanceof PublishFailure) || err.status !== 404) {
          throw err;
        }
      }
    }
    const created = (await this.request('POST', `/repos/${coords.repo}/check-runs`, token, {
      ...body,
      head_sha: coords.sha,
    })) as { id?: unknown };
    return typeof created?.id === 'number' ? created.id : undefined;
  }

  private async postCommitStatus(
    token: string,
    coords: CheckCoordinates,
    desired: DesiredCheckState,
  ): Promise<void> {
    const status = commitStatusForDesired(desired);
    await this.request('POST', `/repos/${coords.repo}/statuses/${coords.sha}`, token, {
      state: status.state,
      context: coords.context,
      description: status.description,
      ...(status.targetUrl !== undefined ? { target_url: status.targetUrl } : {}),
    });
  }

  private async request(
    method: string,
    path: string,
    token: string,
    body?: unknown,
  ): Promise<unknown> {
    const response = await this.options.fetchLike(`${BASE_URL}${path}`, {
      method,
      headers: {
        Accept: 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2022-11-28',
        'User-Agent': 'millwright-reporter',
        Authorization: `Bearer ${token}`,
        ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
      },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
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
      throw new PublishFailure(
        `GitHub ${method} ${path} failed (${response.status}): ${detail}`,
        parseRetryAfter(response.headers.get('retry-after')),
        response.status,
      );
    }
    return json;
  }
}

function parseRetryAfter(header: string | null): number | undefined {
  if (!header) {
    return undefined;
  }
  const seconds = Number(header);
  return Number.isFinite(seconds) && seconds >= 0 ? seconds : undefined;
}
