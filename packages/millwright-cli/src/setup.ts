/**
 * `millwright setup [--pat]` (spec §13.1, §15): create the per-deployment
 * GitHub App via the manifest flow (or take a fine-grained PAT in fallback
 * mode), store the credentials as a SecureString under the deployment CMK,
 * and seed the SSH host-key pins from GitHub's /meta endpoint.
 */

import {
  githubAppParameterName,
  hostKeysParameterName,
  serializeGithubCredentials,
} from '@copperbox/millwright-state';
import {
  CommandError,
  configKeyId,
  getOptionalParameter,
  putSecureStringParameter,
  putStringParameter,
} from './config-plane';
import { DiscoverOptions, SsmClientLike, discoverDeployment } from './discovery';
import { ManifestFlowOptions, runManifestFlow } from './github/manifest-flow';
import { ConvertedApp, FetchLike, getGithubMeta, getTokenIdentity } from './github/rest';

export interface SetupDeps {
  readonly ssm: SsmClientLike;
  readonly fetchLike: FetchLike;
  readonly output: (line: string) => void;
  /** Reads the PAT without echoing; only used with --pat. */
  readonly promptSecret: (question: string) => Promise<string>;
  /** The browser round-trip; injectable for tests. */
  readonly manifestFlow?: (options: ManifestFlowOptions) => Promise<ConvertedApp>;
}

export interface SetupOptions extends DiscoverOptions {
  /** Fine-grained-PAT fallback mode (spec §13.1). */
  readonly pat?: boolean;
  /** Create the App under this organization instead of the user account. */
  readonly org?: string;
  /** App name; GitHub App names are globally unique, so collisions need this. */
  readonly appName?: string;
  /** Replace existing credentials instead of refusing. */
  readonly force?: boolean;
}

/** known_hosts-style pin lines from /meta's bare `<algo> <base64>` entries. */
export function hostKeysParameterValue(sshKeys: readonly string[]): string {
  return sshKeys.map((key) => `github.com ${key}`).join('\n');
}

export async function setup(deps: SetupDeps, options: SetupOptions = {}): Promise<void> {
  const deployment = await discoverDeployment(deps.ssm, options);
  const keyId = configKeyId(deployment);
  const credentialsParameter = githubAppParameterName(deployment.name);

  const existing = await getOptionalParameter(deps.ssm, credentialsParameter);
  if (existing !== undefined && !options.force) {
    throw new CommandError(
      `${credentialsParameter} already exists. Re-running setup would replace the deployment's ` +
        'GitHub credentials; pass --force if that is what you want.',
    );
  }

  if (options.pat) {
    const token = (
      await deps.promptSecret('Paste a fine-grained PAT (contents: read, statuses: write, administration: write): ')
    ).trim();
    if (!token) {
      throw new CommandError('no token entered — aborting setup');
    }
    const identity = await getTokenIdentity(deps.fetchLike, token);
    await putSecureStringParameter(
      deps.ssm,
      credentialsParameter,
      serializeGithubCredentials({ mode: 'pat', token }),
      keyId,
      `millwright GitHub PAT credentials (${deployment.name})`,
    );
    deps.output(`Stored PAT credentials for ${identity.login} at ${credentialsParameter}.`);
    deps.output(
      'PAT mode reports commit statuses instead of check runs, with identical context names — ' +
        'branch protection works the same.',
    );
  } else {
    const flow = deps.manifestFlow ?? runManifestFlow;
    const app = await flow({
      appName: options.appName ?? `millwright-${deployment.name}`,
      org: options.org,
      fetchLike: deps.fetchLike,
      output: deps.output,
    });
    await putSecureStringParameter(
      deps.ssm,
      credentialsParameter,
      serializeGithubCredentials({
        mode: 'app',
        appId: app.appId,
        slug: app.slug,
        privateKeyPem: app.privateKeyPem,
      }),
      keyId,
      `millwright GitHub App credentials (${deployment.name})`,
    );
    deps.output(`Created GitHub App "${app.slug}" (id ${app.appId}); stored at ${credentialsParameter}.`);
    deps.output(
      `Install it on the repos millwright will watch: ${app.htmlUrl}/installations/new ` +
        '(installation rate limit starts at 5,000 req/hr, capped at 12,500).',
    );
  }

  const meta = await getGithubMeta(deps.fetchLike);
  const hostKeysParameter = hostKeysParameterName(deployment.name);
  await putStringParameter(
    deps.ssm,
    hostKeysParameter,
    hostKeysParameterValue(meta.sshKeys),
    `pinned GitHub SSH host keys (${deployment.name})`,
  );
  deps.output(`Pinned ${meta.sshKeys.length} GitHub SSH host keys at ${hostKeysParameter}.`);
  deps.output('Next: millwright repo add <owner/repo>.');
}
