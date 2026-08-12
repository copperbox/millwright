import {
  GetParameterCommand,
  GetParametersByPathCommand,
  ParameterNotFound,
} from '@aws-sdk/client-ssm';
import { describe, expect, it } from 'vitest';
import { DEPLOYMENT_ENV_VAR, DiscoveryError, discoverDeployment, SsmClientLike } from '../src';

interface ParameterFixture {
  Name: string;
  Value: string;
}

function manifest(name: string): ParameterFixture {
  return {
    Name: `/millwright/${name}/manifest`,
    Value: JSON.stringify({ deploymentName: name, version: '0.1.0', schemaVersion: 1 }),
  };
}

/** Fake SSM: serves GetParametersByPath (paged) and GetParameter from fixtures. */
function fakeSsm(parameters: ParameterFixture[], pageSize = 10): SsmClientLike {
  return {
    async send(command: unknown) {
      if (command instanceof GetParametersByPathCommand) {
        const { NextToken } = command.input;
        const start = NextToken ? Number(NextToken) : 0;
        const page = parameters.slice(start, start + pageSize);
        const nextStart = start + pageSize;
        return {
          Parameters: page,
          NextToken: nextStart < parameters.length ? String(nextStart) : undefined,
        };
      }
      if (command instanceof GetParameterCommand) {
        const found = parameters.find((p) => p.Name === command.input.Name);
        if (!found) {
          throw new ParameterNotFound({ message: 'not found', $metadata: {} });
        }
        return { Parameter: found };
      }
      throw new Error(`Unexpected command: ${command?.constructor?.name}`);
    },
  };
}

describe('discoverDeployment', () => {
  it('auto-picks with zero configuration when exactly one deployment exists', async () => {
    const deployment = await discoverDeployment(fakeSsm([manifest('millwright')]), { env: {} });
    expect(deployment.name).toBe('millwright');
    expect(deployment.manifestParameterName).toBe('/millwright/millwright/manifest');
    expect(deployment.manifest.schemaVersion).toBe(1);
  });

  it('ignores non-manifest parameters under /millwright when counting deployments', async () => {
    const noise: ParameterFixture[] = [
      { Name: '/millwright/prod/repos/acme%2Fapi/config', Value: '{}' },
      { Name: '/millwright/prod/github/host-keys', Value: 'ssh-ed25519 ...' },
    ];
    const deployment = await discoverDeployment(fakeSsm([...noise, manifest('prod')]), { env: {} });
    expect(deployment.name).toBe('prod');
  });

  it('paginates the listing', async () => {
    const noise = Array.from({ length: 25 }, (_, i) => ({
      Name: `/millwright/solo/other-${i}`,
      Value: 'x',
    }));
    const deployment = await discoverDeployment(fakeSsm([...noise, manifest('solo')], 7), {
      env: {},
    });
    expect(deployment.name).toBe('solo');
  });

  it('errors clearly when no deployment exists', async () => {
    await expect(discoverDeployment(fakeSsm([]), { env: {} })).rejects.toThrow(
      /No millwright deployment found/,
    );
  });

  it(`errors naming ${DEPLOYMENT_ENV_VAR} and --deployment when several exist`, async () => {
    const err = await discoverDeployment(fakeSsm([manifest('prod'), manifest('staging')]), {
      env: {},
    }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(DiscoveryError);
    expect((err as Error).message).toContain(DEPLOYMENT_ENV_VAR);
    expect((err as Error).message).toContain('--deployment');
    expect((err as Error).message).toContain('prod, staging');
  });

  it('honours an explicit --deployment name over auto-discovery', async () => {
    const deployment = await discoverDeployment(fakeSsm([manifest('prod'), manifest('staging')]), {
      explicitName: 'staging',
      env: {},
    });
    expect(deployment.name).toBe('staging');
  });

  it(`honours ${DEPLOYMENT_ENV_VAR} from the environment`, async () => {
    const deployment = await discoverDeployment(fakeSsm([manifest('prod'), manifest('staging')]), {
      env: { [DEPLOYMENT_ENV_VAR]: 'prod' },
    });
    expect(deployment.name).toBe('prod');
  });

  it('errors clearly when the selected deployment does not exist', async () => {
    await expect(
      discoverDeployment(fakeSsm([manifest('prod')]), { explicitName: 'nope', env: {} }),
    ).rejects.toThrow(/No millwright deployment named "nope"/);
  });
});
