/**
 * GitHub App creation via the manifest flow (spec §13.1): the CLI serves a
 * one-page local site whose form auto-POSTs the App manifest to GitHub; the
 * operator approves in the browser; GitHub redirects back to the local
 * callback with a temporary code; the CLI exchanges it for the App id +
 * private key PEM. No webhook — millwright polls (hook_attributes inactive).
 */

import { randomBytes } from 'node:crypto';
import { createServer } from 'node:http';
import { AddressInfo } from 'node:net';
import { ConvertedApp, FetchLike, convertAppManifestCode } from './rest';

/** App permissions, exactly the spec §13.1 set. */
export const APP_PERMISSIONS = {
  contents: 'read',
  checks: 'write',
  statuses: 'write',
  pull_requests: 'read',
  administration: 'write',
} as const;

export interface AppManifest {
  readonly name: string;
  readonly url: string;
  readonly redirect_url: string;
  readonly public: false;
  readonly default_permissions: typeof APP_PERMISSIONS;
  readonly hook_attributes: { readonly active: false };
}

export function buildAppManifest(options: { appName: string; redirectUrl: string }): AppManifest {
  return {
    name: options.appName,
    url: 'https://github.com/copperbox/millwright',
    redirect_url: options.redirectUrl,
    public: false,
    default_permissions: APP_PERMISSIONS,
    hook_attributes: { active: false },
  };
}

/** Where the manifest form POSTs: personal account, or an organization. */
export function manifestSubmitUrl(state: string, org?: string): string {
  const base = org
    ? `https://github.com/organizations/${encodeURIComponent(org)}/settings/apps/new`
    : 'https://github.com/settings/apps/new';
  return `${base}?state=${encodeURIComponent(state)}`;
}

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/** The local page: an auto-submitting form carrying the manifest JSON. */
export function manifestFlowPage(manifest: AppManifest, submitUrl: string): string {
  const json = JSON.stringify(manifest);
  return `<!doctype html>
<html>
<head><meta charset="utf-8"><title>millwright setup</title></head>
<body>
  <p>Redirecting to GitHub to create the <strong>${escapeHtml(manifest.name)}</strong> App…</p>
  <form id="manifest-form" action="${escapeHtml(submitUrl)}" method="post">
    <input type="hidden" name="manifest" value="${escapeHtml(json)}">
    <noscript><button type="submit">Create GitHub App</button></noscript>
  </form>
  <script>document.getElementById('manifest-form').submit();</script>
</body>
</html>
`;
}

export interface ManifestFlowOptions {
  readonly appName: string;
  /** Create the App under an organization instead of the operator's account. */
  readonly org?: string;
  readonly fetchLike: FetchLike;
  /** Progress lines for the operator (the URL to open, etc.). */
  readonly output: (line: string) => void;
  /** @default 0 — an ephemeral port */
  readonly port?: number;
  /** Give up if the browser round-trip never completes. @default 10 minutes */
  readonly timeoutMs?: number;
  /** CSRF state; injectable for tests. @default random */
  readonly state?: string;
}

/**
 * Run the whole browser round-trip and resolve with the converted App
 * credentials. The temporary server binds to 127.0.0.1 only.
 */
export function runManifestFlow(options: ManifestFlowOptions): Promise<ConvertedApp> {
  const state = options.state ?? randomBytes(16).toString('hex');
  return new Promise<ConvertedApp>((resolve, reject) => {
    let settled = false;
    const server = createServer();
    const timer = setTimeout(() => {
      finish(() => reject(new Error('timed out waiting for the GitHub App creation round-trip')));
    }, options.timeoutMs ?? 600_000);

    function finish(outcome: () => void): void {
      if (!settled) {
        settled = true;
        clearTimeout(timer);
        server.close();
        outcome();
      }
    }

    server.on('request', (request, response) => {
      const url = new URL(request.url ?? '/', 'http://127.0.0.1');
      if (url.pathname === '/') {
        const port = (server.address() as AddressInfo).port;
        const manifest = buildAppManifest({
          appName: options.appName,
          redirectUrl: `http://127.0.0.1:${port}/callback`,
        });
        response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        response.end(manifestFlowPage(manifest, manifestSubmitUrl(state, options.org)));
        return;
      }
      if (url.pathname === '/callback') {
        if (url.searchParams.get('state') !== state) {
          // Not our round-trip; refuse it but keep waiting for the real one.
          response.writeHead(403, { 'Content-Type': 'text/plain' });
          response.end('state mismatch');
          return;
        }
        const code = url.searchParams.get('code');
        if (!code) {
          response.writeHead(400, { 'Content-Type': 'text/plain' });
          response.end('missing code');
          return;
        }
        convertAppManifestCode(options.fetchLike, code).then(
          (app) => {
            response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
            response.end(
              `<!doctype html><body><p>GitHub App <strong>${escapeHtml(app.slug)}</strong> ` +
                'created. You can close this tab and return to the terminal.</p></body>',
            );
            finish(() => resolve(app));
          },
          (err) => {
            response.writeHead(502, { 'Content-Type': 'text/plain' });
            response.end('manifest conversion failed; see the terminal');
            finish(() => reject(err));
          },
        );
        return;
      }
      response.writeHead(404, { 'Content-Type': 'text/plain' });
      response.end('not found');
    });

    server.on('error', (err) => finish(() => reject(err)));
    server.listen(options.port ?? 0, '127.0.0.1', () => {
      const port = (server.address() as AddressInfo).port;
      options.output(`Open http://127.0.0.1:${port}/ in your browser to create the GitHub App.`);
      options.output('Waiting for GitHub to redirect back…');
    });
  });
}
