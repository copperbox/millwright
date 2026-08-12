import {
  GetParameterCommand,
  GetParametersByPathCommand,
  ParameterNotFound,
} from '@aws-sdk/client-ssm';
import {
  deploymentNameFromManifestParameter,
  manifestParameterName,
} from '@copperbox/millwright-state';

export const DEPLOYMENT_ENV_VAR = 'MILLWRIGHT_DEPLOYMENT';

/** Contents of /millwright/<name>/manifest, written by the Millwright construct. */
export interface DeploymentManifest {
  readonly deploymentName: string;
  readonly version: string;
  readonly schemaVersion: number;
  readonly [key: string]: unknown;
}

export interface Deployment {
  readonly name: string;
  readonly manifestParameterName: string;
  readonly manifest: DeploymentManifest;
}

/** The slice of SSMClient discovery uses; lets tests inject a fake. */
export interface SsmClientLike {
  send(command: unknown): Promise<any>;
}

export interface DiscoverOptions {
  /** Explicit deployment name from --deployment; wins over the environment. */
  readonly explicitName?: string;
  /** Environment to consult for MILLWRIGHT_DEPLOYMENT. @default process.env */
  readonly env?: Record<string, string | undefined>;
}

export class DiscoveryError extends Error {}

function parseManifest(name: string, raw: string | undefined): DeploymentManifest {
  if (!raw) {
    throw new DiscoveryError(`Deployment "${name}" has an empty manifest parameter`);
  }
  try {
    return JSON.parse(raw) as DeploymentManifest;
  } catch {
    throw new DiscoveryError(`Deployment "${name}" has an unparseable manifest parameter`);
  }
}

async function listDeploymentNames(client: SsmClientLike): Promise<string[]> {
  const names: string[] = [];
  let nextToken: string | undefined;
  do {
    const page = await client.send(
      new GetParametersByPathCommand({
        Path: '/millwright',
        Recursive: true,
        NextToken: nextToken,
      }),
    );
    for (const parameter of page.Parameters ?? []) {
      const name = parameter.Name && deploymentNameFromManifestParameter(parameter.Name);
      if (name) {
        names.push(name);
      }
    }
    nextToken = page.NextToken;
  } while (nextToken);
  return names;
}

async function getDeployment(client: SsmClientLike, name: string): Promise<Deployment> {
  let parameterName: string;
  try {
    parameterName = manifestParameterName(name);
  } catch {
    throw new DiscoveryError(`"${name}" is not a valid millwright deployment name`);
  }
  let value: string | undefined;
  try {
    const result = await client.send(new GetParameterCommand({ Name: parameterName }));
    value = result.Parameter?.Value;
  } catch (err) {
    if (err instanceof ParameterNotFound) {
      throw new DiscoveryError(
        `No millwright deployment named "${name}" in this AWS account/region ` +
          `(${parameterName} does not exist). Check ${DEPLOYMENT_ENV_VAR} / --deployment ` +
          'and your AWS credentials/region.',
      );
    }
    throw err;
  }
  return { name, manifestParameterName: parameterName, manifest: parseManifest(name, value) };
}

/**
 * Locate the millwright deployment to operate on.
 *
 * AWS credentials are the only auth. With no explicit selection, lists
 * /millwright/* and auto-picks when the account+region has exactly one
 * deployment; otherwise fails with a message naming MILLWRIGHT_DEPLOYMENT and
 * --deployment. No committed pointer file is ever consulted.
 */
export async function discoverDeployment(
  client: SsmClientLike,
  options: DiscoverOptions = {},
): Promise<Deployment> {
  const env = options.env ?? process.env;
  const explicit = options.explicitName ?? env[DEPLOYMENT_ENV_VAR];
  if (explicit) {
    return getDeployment(client, explicit);
  }

  const names = await listDeploymentNames(client);
  if (names.length === 1) {
    return getDeployment(client, names[0]);
  }
  if (names.length === 0) {
    throw new DiscoveryError(
      'No millwright deployment found in this AWS account/region. Deploy one with ' +
        '"millwright init" + "cdk deploy", or switch AWS credentials/region — ' +
        `${DEPLOYMENT_ENV_VAR} / --deployment only selects among visible deployments.`,
    );
  }
  throw new DiscoveryError(
    `Multiple millwright deployments found in this AWS account/region: ${names.sort().join(', ')}. ` +
      `Select one with ${DEPLOYMENT_ENV_VAR} or --deployment.`,
  );
}
