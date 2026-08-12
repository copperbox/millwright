import { createVerify, generateKeyPairSync } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  GithubApiError,
  InstallationTokenMinter,
  parseGithubAppParameter,
  rateLimitResetMs,
} from '../src/runtime/poller/github-app';

const NOW = 1_760_000_000_000;
const { publicKey, privateKey } = generateKeyPairSync('rsa', {
  modulusLength: 2048,
  publicKeyEncoding: { type: 'spki', format: 'pem' },
  privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
});
const APP_PARAMETER = JSON.stringify({ appId: 12345, privateKey });

interface Call {
  url: string;
  method: string;
  authorization: string;
}

/** Scripted GitHub API: installation lookups and token mints, journaled. */
function fakeApi(options: { failMint?: () => number | undefined; tokenTtlMs?: number } = {}) {
  const calls: Call[] = [];
  let clockNow = NOW;
  let minted = 0;
  const fetchImpl = async (url: string, init: RequestInit): Promise<Response> => {
    const headers = init.headers as Record<string, string>;
    calls.push({ url, method: init.method ?? 'GET', authorization: headers.authorization });
    const path = new URL(url).pathname;
    const match = path.match(/^\/repos\/([^/]+)\/[^/]+\/installation$/);
    if (match) {
      return Response.json({ id: match[1].length * 1000 }, { status: 200 });
    }
    if (/^\/app\/installations\/\d+\/access_tokens$/.test(path)) {
      const failStatus = options.failMint?.();
      if (failStatus) {
        return Response.json(
          { message: 'nope' },
          {
            status: failStatus,
            headers:
              failStatus === 403
                ? { 'x-ratelimit-remaining': '0', 'x-ratelimit-reset': '1760000900' }
                : {},
          },
        );
      }
      minted += 1;
      const expires = new Date(clockNow + (options.tokenTtlMs ?? 60 * 60 * 1000)).toISOString();
      return Response.json({ token: `ghs_token_${minted}`, expires_at: expires }, { status: 201 });
    }
    return Response.json({ message: 'not found' }, { status: 404 });
  };
  const minter = new InstallationTokenMinter(
    async () => APP_PARAMETER,
    fetchImpl,
    () => clockNow,
    'https://api.github.example',
  );
  return { minter, calls, advance: (ms: number) => (clockNow += ms) };
}

describe('parseGithubAppParameter', () => {
  it('accepts numeric and string app ids', () => {
    expect(parseGithubAppParameter(APP_PARAMETER)).toEqual({ appId: '12345', privateKey });
    expect(parseGithubAppParameter(JSON.stringify({ appId: '77', privateKey }))?.appId).toBe('77');
  });

  it('rejects missing, unparseable, or incomplete payloads', () => {
    expect(parseGithubAppParameter(undefined)).toBeUndefined();
    expect(parseGithubAppParameter('not json')).toBeUndefined();
    expect(parseGithubAppParameter(JSON.stringify({ appId: 1 }))).toBeUndefined();
    expect(parseGithubAppParameter(JSON.stringify({ privateKey }))).toBeUndefined();
  });
});

describe('InstallationTokenMinter', () => {
  it('mints via a verifiable RS256 App JWT and caches the token', async () => {
    const { minter, calls } = fakeApi();
    expect(await minter.configured()).toBe(true);
    const token = await minter.tokenFor('octo/app');
    expect(token).toBe('ghs_token_1');

    // Lookup then mint, both under the App JWT.
    expect(calls.map((c) => `${c.method} ${new URL(c.url).pathname}`)).toEqual([
      'GET /repos/octo/app/installation',
      'POST /app/installations/4000/access_tokens',
    ]);
    const jwt = calls[0].authorization.replace('Bearer ', '');
    const [header, payload, signature] = jwt.split('.');
    expect(JSON.parse(Buffer.from(header, 'base64url').toString())).toEqual({
      alg: 'RS256',
      typ: 'JWT',
    });
    const claims = JSON.parse(Buffer.from(payload, 'base64url').toString());
    expect(claims.iss).toBe('12345');
    expect(claims.iat).toBe(Math.floor(NOW / 1000) - 60);
    expect(claims.exp - claims.iat).toBeLessThanOrEqual(10 * 60);
    const verified = createVerify('RSA-SHA256')
      .update(`${header}.${payload}`)
      .verify(publicKey, Buffer.from(signature, 'base64url'));
    expect(verified).toBe(true);

    // Same owner, other repo: cached installation AND cached token — no calls.
    expect(await minter.tokenFor('octo/other')).toBe('ghs_token_1');
    expect(calls).toHaveLength(2);
  });

  it('re-mints once the cached token nears expiry', async () => {
    const { minter, calls, advance } = fakeApi();
    await minter.tokenFor('octo/app');
    advance(56 * 60 * 1000); // inside the 5-minute renewal margin
    expect(await minter.tokenFor('octo/app')).toBe('ghs_token_2');
    // The second mint reused the cached installation id.
    expect(calls.filter((c) => c.url.endsWith('/installation')).length).toBe(1);
  });

  it('does not cache a failed mint and surfaces rate-limit resets', async () => {
    let fail = true;
    const { minter } = fakeApi({ failMint: () => (fail ? 403 : undefined) });
    const err = (await minter.tokenFor('octo/app').catch((e) => e)) as GithubApiError;
    expect(err).toBeInstanceOf(GithubApiError);
    expect(err.status).toBe(403);
    expect(err.rateLimitResetMs).toBe(1_760_000_900_000);

    fail = false;
    expect(await minter.tokenFor('octo/app')).toBe('ghs_token_1');
  });

  it('throws without the github/app parameter and recovers once it appears', async () => {
    let parameter: string | undefined;
    const fetchScript = async (url: string): Promise<Response> => {
      const path = new URL(url).pathname;
      if (path.endsWith('/installation')) {
        return Response.json({ id: 1 }, { status: 200 });
      }
      if (path.endsWith('/access_tokens')) {
        return Response.json(
          { token: 'ghs_late', expires_at: new Date(NOW + 3_600_000).toISOString() },
          { status: 201 },
        );
      }
      return Response.json({}, { status: 404 });
    };
    const minter = new InstallationTokenMinter(
      async () => parameter,
      fetchScript,
      () => NOW,
      'https://api.github.example',
    );
    expect(await minter.configured()).toBe(false);
    await expect(minter.tokenFor('octo/app')).rejects.toBeInstanceOf(GithubApiError);

    parameter = APP_PARAMETER;
    expect(await minter.configured()).toBe(true);
    expect(await minter.tokenFor('octo/app')).toBe('ghs_late');
  });
});

describe('rateLimitResetMs', () => {
  it('reads the reset only when the limit is exhausted', () => {
    expect(
      rateLimitResetMs(
        new Headers({ 'x-ratelimit-remaining': '0', 'x-ratelimit-reset': '1760000900' }),
      ),
    ).toBe(1_760_000_900_000);
    expect(
      rateLimitResetMs(
        new Headers({ 'x-ratelimit-remaining': '12', 'x-ratelimit-reset': '1760000900' }),
      ),
    ).toBeUndefined();
    expect(rateLimitResetMs(new Headers())).toBeUndefined();
  });
});
