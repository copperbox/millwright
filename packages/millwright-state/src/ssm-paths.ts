/**
 * The SSM config plane, `/millwright/<name>/…` (spec §9.2). SecureStrings sit
 * under the deployment's dedicated CMK — reading one takes both
 * `ssm:GetParameter(s)` and `kms:Decrypt` (the two-gate posture).
 *
 * Only the manifest is CloudFormation-managed; every other parameter is
 * written at runtime by the CLI under operator IAM (`millwright setup`,
 * `repo add`, `secrets set`), so these path builders are the single source of
 * truth for where everything lives.
 */

function assertPathSegment(label: string, value: string): void {
  if (!value || !/^[a-zA-Z0-9_.\-/]+$/.test(value) || value.startsWith('/') || value.endsWith('/')) {
    throw new Error(
      `${label} must be non-empty, contain only [a-zA-Z0-9_.-/] and not start or end ` +
        `with "/", got "${value}"`,
    );
  }
}

/** `/millwright/<name>` — root of one deployment's config plane. */
export function configPlaneRoot(deploymentName: string): string {
  assertPathSegment('deploymentName', deploymentName);
  if (deploymentName.includes('/')) {
    throw new Error(`deploymentName must not contain "/", got "${deploymentName}"`);
  }
  return `/millwright/${deploymentName}`;
}

/** String — deployment manifest; the CLI's discovery root. */
export function manifestParameterName(deploymentName: string): string {
  return `${configPlaneRoot(deploymentName)}/manifest`;
}

const MANIFEST_NAME_PATTERN = /^\/millwright\/([^/]+)\/manifest$/;

/** Inverse of `manifestParameterName`; undefined when the name is not a manifest. */
export function deploymentNameFromManifestParameter(parameterName: string): string | undefined {
  return parameterName.match(MANIFEST_NAME_PATTERN)?.[1];
}

/** String (JSON) — `secretsAllowedRefs`, `prPolling`, `forkPrPolicy`, `ecrPullRepos`. */
export function repoConfigParameterName(deploymentName: string, repo: string): string {
  assertPathSegment('repo', repo);
  return `${configPlaneRoot(deploymentName)}/repos/${repo}/config`;
}

/**
 * Inverse of `repoConfigParameterName` for one deployment; undefined when the
 * name is not one of its repo-config parameters. The poller and `repo list`
 * discover repos by listing the `/repos/` prefix and inverting each name.
 */
export function repoFromConfigParameterName(
  deploymentName: string,
  parameterName: string,
): string | undefined {
  const prefix = `${configPlaneRoot(deploymentName)}/repos/`;
  if (!parameterName.startsWith(prefix) || !parameterName.endsWith('/config')) {
    return undefined;
  }
  const repo = parameterName.slice(prefix.length, -'/config'.length);
  return repo.length > 0 ? repo : undefined;
}

/** SecureString — the repo's read-only Ed25519 deploy key. */
export function deployKeyParameterName(deploymentName: string, repo: string): string {
  assertPathSegment('repo', repo);
  return `${configPlaneRoot(deploymentName)}/repos/${repo}/deploy-key`;
}

/** SecureString — GitHub App id + private key PEM from the manifest exchange. */
export function githubAppParameterName(deploymentName: string): string {
  return `${configPlaneRoot(deploymentName)}/github/app`;
}

/** String — pinned SSH host keys, seeded from GitHub's `/meta`. */
export function hostKeysParameterName(deploymentName: string): string {
  return `${configPlaneRoot(deploymentName)}/github/host-keys`;
}

/**
 * SecureString — one workflow secret. `scope` defaults to the repo at the
 * call sites that resolve `Secret` references; it is explicit here.
 */
export function secretParameterName(
  deploymentName: string,
  scope: string,
  secretName: string,
): string {
  assertPathSegment('scope', scope);
  assertPathSegment('secret name', secretName);
  if (secretName.includes('/')) {
    throw new Error(`secret name must not contain "/", got "${secretName}"`);
  }
  return `${configPlaneRoot(deploymentName)}/secrets/${scope}/${secretName}`;
}
