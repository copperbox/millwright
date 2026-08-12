import { GithubCredentials, desiredJobCheck } from '@copperbox/millwright-state';
import { generateKeyPairSync } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { PublishFailure } from '../src/runtime/reporter/reporter';
import { GithubCheckPublisher, ReporterFetch } from '../src/runtime/reporter/github';

const NOW = Date.parse('2026-08-12T06:00:00Z');
const SHA = 'a'.repeat(40);
const COORDS = { repo: 'octocat/app', sha: SHA, context: 'ci / build' };

const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
const PEM = privateKey.export({ type: 'pkcs1', format: 'pem' }).toString();

const APP_CREDENTIALS: GithubCredentials = {
  mode: 'app',
  appId: 4242,
  slug: 'millwright-test',
  privateKeyPem: PEM,
};

interface Call {
  url: string;
  method: string;
  headers: Record<string, string>;
  body?: unknown;
}

function fakeFetch(
  responses: Array<{ status?: number; body?: unknown; headers?: Record<string, string> }>,
): { fetchLike: ReporterFetch; calls: Call[] } {
  const calls: Call[] = [];
  const fetchLike: ReporterFetch = async (url, init) => {
    calls.push({
      url,
      method: init?.method ?? 'GET',
      headers: init?.headers ?? {},
      body: init?.body ? JSON.parse(init.body) : undefined,
    });
    const response = responses.shift() ?? {};
    const status = response.status ?? 200;
    const headerMap = new Map(
      Object.entries(response.headers ?? {}).map(([k, v]) => [k.toLowerCase(), v]),
    );
    return {
      ok: status >= 200 && status < 300,
      status,
      headers: { get: (name: string) => headerMap.get(name.toLowerCase()) ?? null },
      text: async () => (response.body === undefined ? '' : JSON.stringify(response.body)),
    };
  };
  return { fetchLike, calls };
}

function publisher(
  credentials: GithubCredentials,
  fetchLike: ReporterFetch,
): GithubCheckPublisher {
  return new GithubCheckPublisher({
    fetchLike,
    loadCredentials: async () => credentials,
    now: () => NOW,
  });
}

const TOKEN_MINT_RESPONSES = [
  { body: { id: 55 } }, // GET /repos/{repo}/installation
  { status: 201, body: { token: 'ghs_installation', expires_at: '2026-08-12T07:00:00Z' } },
];

describe('App mode', () => {
  it('mints an installation token and creates the check run', async () => {
    const { fetchLike, calls } = fakeFetch([
      ...TOKEN_MINT_RESPONSES,
      { status: 201, body: { id: 777 } },
    ]);
    const desired = desiredJobCheck('queued', { runId: 'ci#142', steps: [] });

    const result = await publisher(APP_CREDENTIALS, fetchLike).publish(COORDS, desired);

    expect(result).toEqual({ checkRunId: 777 });
    expect(calls[0].url).toBe('https://api.github.com/repos/octocat/app/installation');
    expect(calls[0].headers.Authorization).toMatch(/^Bearer eyJ/);
    expect(calls[1].url).toBe('https://api.github.com/app/installations/55/access_tokens');
    expect(calls[2]).toMatchObject({
      url: 'https://api.github.com/repos/octocat/app/check-runs',
      method: 'POST',
      body: {
        name: 'ci / build',
        head_sha: SHA,
        status: 'queued',
        output: { title: 'Queued', summary: desired.summary },
      },
    });
    expect(calls[2].headers.Authorization).toBe('Bearer ghs_installation');
    expect(calls[2].body).not.toHaveProperty('conclusion');
  });

  it('updates the known check run with conclusion and details URL', async () => {
    const { fetchLike, calls } = fakeFetch([
      ...TOKEN_MINT_RESPONSES,
      { body: { id: 777 } },
    ]);
    const desired = desiredJobCheck('FAILED', {
      runId: 'ci#142',
      steps: [],
      detailsUrl: 'https://console.aws.amazon.com/cloudwatch/deep-link',
    });

    const result = await publisher(APP_CREDENTIALS, fetchLike).publish(COORDS, desired, 777);

    expect(result).toEqual({ checkRunId: 777 });
    expect(calls[2]).toMatchObject({
      url: 'https://api.github.com/repos/octocat/app/check-runs/777',
      method: 'PATCH',
      body: {
        status: 'completed',
        conclusion: 'failure',
        details_url: 'https://console.aws.amazon.com/cloudwatch/deep-link',
      },
    });
  });

  it('caches the installation token in memory across publishes', async () => {
    const { fetchLike, calls } = fakeFetch([
      ...TOKEN_MINT_RESPONSES,
      { status: 201, body: { id: 1 } },
      { status: 201, body: { id: 2 } },
    ]);
    const p = publisher(APP_CREDENTIALS, fetchLike);
    const desired = desiredJobCheck('queued', { runId: 'ci#142', steps: [] });

    await p.publish(COORDS, desired);
    await p.publish({ ...COORDS, context: 'ci / test' }, desired);

    const mints = calls.filter((call) => call.url.includes('access_tokens'));
    expect(mints).toHaveLength(1);
    expect(calls).toHaveLength(4);
  });

  it('falls back to creating a fresh run when the stored one is gone (benign duplicate)', async () => {
    const { fetchLike, calls } = fakeFetch([
      ...TOKEN_MINT_RESPONSES,
      { status: 404, body: { message: 'Not Found' } },
      { status: 201, body: { id: 900 } },
    ]);
    const desired = desiredJobCheck('queued', { runId: 'ci#142', steps: [] });

    const result = await publisher(APP_CREDENTIALS, fetchLike).publish(COORDS, desired, 777);

    expect(result).toEqual({ checkRunId: 900 });
    expect(calls[3].method).toBe('POST');
    expect(calls[3].url).toBe('https://api.github.com/repos/octocat/app/check-runs');
  });

  it('surfaces Retry-After on failures so the backoff honors it', async () => {
    const { fetchLike } = fakeFetch([
      ...TOKEN_MINT_RESPONSES,
      { status: 403, body: { message: 'API rate limit exceeded' }, headers: { 'Retry-After': '120' } },
    ]);
    const desired = desiredJobCheck('queued', { runId: 'ci#142', steps: [] });

    const error = await publisher(APP_CREDENTIALS, fetchLike)
      .publish(COORDS, desired)
      .catch((err) => err);

    expect(error).toBeInstanceOf(PublishFailure);
    expect(error.retryAfterSeconds).toBe(120);
    expect(error.status).toBe(403);
  });
});

describe('PAT mode', () => {
  it('degrades to a commit status with the identical context name', async () => {
    const { fetchLike, calls } = fakeFetch([{ status: 201, body: {} }]);
    const desired = desiredJobCheck('SUCCEEDED', {
      runId: 'ci#142',
      steps: [],
      detailsUrl: 'https://example.test/logs',
    });

    const result = await publisher({ mode: 'pat', token: 'github_pat_x' }, fetchLike).publish(
      COORDS,
      desired,
      777,
    );

    expect(result).toEqual({});
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({
      url: `https://api.github.com/repos/octocat/app/statuses/${SHA}`,
      method: 'POST',
      body: {
        state: 'success',
        context: 'ci / build',
        description: 'Succeeded',
        target_url: 'https://example.test/logs',
      },
    });
    expect(calls[0].headers.Authorization).toBe('Bearer github_pat_x');
  });
});
