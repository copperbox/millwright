import { describe, expect, it } from 'vitest';
import {
  buildAppManifest,
  manifestFlowPage,
  manifestSubmitUrl,
  runManifestFlow,
} from '../src/github/manifest-flow';
import { FetchLike } from '../src/github/rest';

const CONVERSION = {
  status: 201,
  json: { id: 7, slug: 'millwright-prod', pem: 'PEM', html_url: 'https://github.com/apps/millwright-prod' },
};

function conversionFetch(calls: string[] = []): FetchLike {
  return async (url) => {
    calls.push(url);
    return { ok: true, status: 201, text: async () => JSON.stringify(CONVERSION.json) };
  };
}

describe('buildAppManifest', () => {
  it('carries exactly the spec §13.1 permission set and no webhook', () => {
    const manifest = buildAppManifest({
      appName: 'millwright-prod',
      redirectUrl: 'http://127.0.0.1:1234/callback',
    });
    expect(manifest.default_permissions).toEqual({
      contents: 'read',
      checks: 'write',
      statuses: 'write',
      pull_requests: 'read',
      administration: 'write',
    });
    expect(manifest.public).toBe(false);
    expect(manifest.hook_attributes).toEqual({ active: false });
    expect(manifest.redirect_url).toBe('http://127.0.0.1:1234/callback');
  });
});

describe('manifestSubmitUrl', () => {
  it('targets the personal or organization app-creation endpoint', () => {
    expect(manifestSubmitUrl('s1')).toBe('https://github.com/settings/apps/new?state=s1');
    expect(manifestSubmitUrl('s1', 'copperbox')).toBe(
      'https://github.com/organizations/copperbox/settings/apps/new?state=s1',
    );
  });
});

describe('manifestFlowPage', () => {
  it('embeds the manifest JSON in an auto-submitting form, HTML-escaped', () => {
    const manifest = buildAppManifest({ appName: 'a"b', redirectUrl: 'http://127.0.0.1:1/callback' });
    const page = manifestFlowPage(manifest, manifestSubmitUrl('s'));
    expect(page).toContain('action="https://github.com/settings/apps/new?state=s"');
    expect(page).toContain('name="manifest"');
    expect(page).not.toContain('a"b');
    expect(page).toContain('a&quot;b');
  });
});

describe('runManifestFlow', () => {
  it('serves the form, exchanges the callback code, and resolves with App creds', async () => {
    const printed: string[] = [];
    const conversionCalls: string[] = [];
    const flow = runManifestFlow({
      appName: 'millwright-prod',
      fetchLike: conversionFetch(conversionCalls),
      output: (line) => printed.push(line),
      state: 'test-state',
      timeoutMs: 5_000,
    });

    // The operator-facing URL is printed once the server listens.
    await new Promise((r) => setTimeout(r, 20));
    const url = printed[0].match(/http:\/\/127\.0\.0\.1:\d+\//)![0];

    const page = await fetch(url).then((r) => r.text());
    expect(page).toContain('millwright-prod');
    expect(page).toContain('&quot;administration&quot;:&quot;write&quot;');

    // Wrong state is refused and the flow keeps waiting.
    const bad = await fetch(`${url}callback?code=evil&state=wrong`);
    expect(bad.status).toBe(403);

    const good = await fetch(`${url}callback?code=temp123&state=test-state`);
    expect(good.status).toBe(200);

    await expect(flow).resolves.toEqual({
      appId: 7,
      slug: 'millwright-prod',
      privateKeyPem: 'PEM',
      htmlUrl: 'https://github.com/apps/millwright-prod',
    });
    expect(conversionCalls).toEqual(['https://api.github.com/app-manifests/temp123/conversions']);
  });

  it('rejects when the round-trip times out', async () => {
    await expect(
      runManifestFlow({
        appName: 'x',
        fetchLike: conversionFetch(),
        output: () => {},
        timeoutMs: 30,
      }),
    ).rejects.toThrow(/timed out/);
  });
});
