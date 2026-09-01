import { describe, expect, it } from 'vitest';
import { CommandError } from '../src/config-plane';
import { SecretsDeps, parseGithubRemote, secretsSet } from '../src/secrets';
import { FakeSsm } from './fake-ssm';

function fixture(overrides: Partial<SecretsDeps> = {}) {
  const ssm = new FakeSsm();
  ssm.setManifest('prod');
  const lines: string[] = [];
  const deps: SecretsDeps = {
    ssm,
    output: (line) => lines.push(line),
    promptSecret: async () => 'hunter2',
    inferRepo: async () => undefined,
    ...overrides,
  };
  return { ssm, deps, lines };
}

describe('secrets set', () => {
  it('writes a SecureString under the deployment CMK at the scoped path', async () => {
    const { ssm, deps, lines } = fixture();
    await secretsSet(deps, { name: 'NPM_TOKEN', scope: 'acme/api' });
    const stored = ssm.parameters.get('/millwright/prod/secrets/acme/api/NPM_TOKEN');
    expect(stored).toMatchObject({
      Value: 'hunter2',
      Type: 'SecureString',
      KeyId: 'arn:aws:kms:us-east-1:123456789012:key/test-cmk',
    });
    expect(lines[0]).toBe('Wrote /millwright/prod/secrets/acme/api/NPM_TOKEN (scope acme/api).');
  });

  it('defaults the scope to the repo inferred from the origin remote', async () => {
    const { ssm, deps } = fixture({ inferRepo: async () => 'acme/web' });
    await secretsSet(deps, { name: 'DEPLOY_TOKEN' });
    expect(ssm.parameters.has('/millwright/prod/secrets/acme/web/DEPLOY_TOKEN')).toBe(true);
  });

  it('demands --scope when no origin remote is inferable', async () => {
    const { deps } = fixture();
    await expect(secretsSet(deps, { name: 'NPM_TOKEN' })).rejects.toThrow(/pass --scope/);
  });

  it('accepts kebab-case parameter names as the docs use', async () => {
    const { ssm, deps } = fixture();
    await secretsSet(deps, { name: 'npm-token', scope: 'acme/api' });
    expect(ssm.parameters.has('/millwright/prod/secrets/acme/api/npm-token')).toBe(true);
  });

  it('rejects names that cannot be SSM path segments', async () => {
    const { deps } = fixture();
    await expect(secretsSet(deps, { name: 'not/a/name', scope: 'acme/api' })).rejects.toThrow(
      CommandError,
    );
    await expect(secretsSet(deps, { name: '', scope: 'acme/api' })).rejects.toThrow(CommandError);
  });

  it('refuses an empty value', async () => {
    const { deps } = fixture({ promptSecret: async () => '' });
    await expect(secretsSet(deps, { name: 'NPM_TOKEN', scope: 'acme/api' })).rejects.toThrow(
      /nothing written/,
    );
  });
});

describe('parseGithubRemote', () => {
  it('handles the usual remote URL shapes', () => {
    expect(parseGithubRemote('git@github.com:acme/api.git')).toBe('acme/api');
    expect(parseGithubRemote('git@github.com:acme/api')).toBe('acme/api');
    expect(parseGithubRemote('ssh://git@github.com/acme/api.git')).toBe('acme/api');
    expect(parseGithubRemote('https://github.com/acme/api')).toBe('acme/api');
    expect(parseGithubRemote('https://github.com/acme/api.git')).toBe('acme/api');
    expect(parseGithubRemote('https://gitlab.com/acme/api')).toBeUndefined();
    expect(parseGithubRemote('nonsense')).toBeUndefined();
  });
});
