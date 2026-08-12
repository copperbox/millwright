/**
 * Runtime reads/writes on the SSM config plane (spec §9.2). Every parameter
 * except the manifest is written here, under operator IAM — that gating is
 * the config split (spec §3.3). SecureStrings go under the deployment CMK
 * carried in the manifest, completing the two-gate posture.
 */

import {
  DeleteParametersCommand,
  GetParameterCommand,
  GetParametersByPathCommand,
  ParameterNotFound,
  PutParameterCommand,
} from '@aws-sdk/client-ssm';
import { Deployment, SsmClientLike } from './discovery';

/** A user-facing failure: printed, not stack-traced. */
export class CommandError extends Error {}

/** The CMK all config-plane SecureStrings sit under, from the manifest. */
export function configKeyId(deployment: Deployment): string {
  const resources = deployment.manifest.resources as
    | { configKeyArn?: unknown; configKeyAlias?: unknown }
    | undefined;
  const keyId = resources?.configKeyArn ?? resources?.configKeyAlias;
  if (typeof keyId !== 'string' || !keyId) {
    throw new CommandError(
      `Deployment "${deployment.name}" has no configKeyArn in its manifest — ` +
        'redeploy with a current @copperbox/millwright-cdk before running setup.',
    );
  }
  return keyId;
}

/** Bus for CLI-emitted events, once the control plane provisions it. */
export function eventBusName(deployment: Deployment): string | undefined {
  const resources = deployment.manifest.resources as { eventBus?: unknown } | undefined;
  return typeof resources?.eventBus === 'string' && resources.eventBus
    ? resources.eventBus
    : undefined;
}

export async function getOptionalParameter(
  client: SsmClientLike,
  name: string,
  options: { decrypt?: boolean } = {},
): Promise<string | undefined> {
  try {
    const result = await client.send(
      new GetParameterCommand({ Name: name, WithDecryption: options.decrypt ?? false }),
    );
    return result.Parameter?.Value;
  } catch (err) {
    if (err instanceof ParameterNotFound) {
      return undefined;
    }
    throw err;
  }
}

export async function putStringParameter(
  client: SsmClientLike,
  name: string,
  value: string,
  description: string,
): Promise<void> {
  await client.send(
    new PutParameterCommand({
      Name: name,
      Value: value,
      Type: 'String',
      Description: description,
      Overwrite: true,
    }),
  );
}

export async function putSecureStringParameter(
  client: SsmClientLike,
  name: string,
  value: string,
  keyId: string,
  description: string,
): Promise<void> {
  await client.send(
    new PutParameterCommand({
      Name: name,
      Value: value,
      Type: 'SecureString',
      KeyId: keyId,
      Description: description,
      Overwrite: true,
    }),
  );
}

/** Delete parameters that may or may not exist; returns the ones deleted. */
export async function deleteParameters(
  client: SsmClientLike,
  names: readonly string[],
): Promise<string[]> {
  const result = await client.send(new DeleteParametersCommand({ Names: [...names] }));
  return (result.DeletedParameters ?? []) as string[];
}

export interface ListedParameter {
  readonly name: string;
  readonly value: string;
}

export async function listParametersByPrefix(
  client: SsmClientLike,
  prefix: string,
): Promise<ListedParameter[]> {
  const parameters: ListedParameter[] = [];
  let nextToken: string | undefined;
  do {
    const page = await client.send(
      new GetParametersByPathCommand({ Path: prefix, Recursive: true, NextToken: nextToken }),
    );
    for (const parameter of page.Parameters ?? []) {
      if (parameter.Name && parameter.Value !== undefined) {
        parameters.push({ name: parameter.Name, value: parameter.Value });
      }
    }
    nextToken = page.NextToken;
  } while (nextToken);
  return parameters;
}
