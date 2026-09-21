import { describe, expect, it } from 'vitest';
import { CommandError } from '../src/config-plane';
import { SecretsDeps, parseGithubRemote, secretsList, secretsRm, secretsSet } from '../src/secrets';
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

describe('secrets list', () => {
  it('lists the secret names for a scope, sorted, without values', async () => {
    const { ssm, deps, lines } = fixture();
    ssm.set('/millwright/prod/secrets/acme/api/NPM_TOKEN', 'hunter2', 'SecureString');
    ssm.set('/millwright/prod/secrets/acme/api/AWS_KEY', 'sekrit', 'SecureString');
    ssm.set('/millwright/prod/secrets/acme/web/OTHER', 'nope', 'SecureString');
    const entries = await secretsList(deps, { scope: 'acme/api' });
    expect(entries).toEqual([
      { scope: 'acme/api', name: 'AWS_KEY' },
      { scope: 'acme/api', name: 'NPM_TOKEN' },
    ]);
    expect(lines).toEqual(['Secrets in scope acme/api (deployment "prod"):', 'AWS_KEY', 'NPM_TOKEN']);
    expect(lines.join('\n')).not.toContain('hunter2');
  });

  it('defaults the scope to the repo inferred from the origin remote', async () => {
    const { ssm, deps } = fixture({ inferRepo: async () => 'acme/web' });
    ssm.set('/millwright/prod/secrets/acme/web/DEPLOY_TOKEN', 'x', 'SecureString');
    const entries = await secretsList(deps, {});
    expect(entries.map((e) => e.name)).toEqual(['DEPLOY_TOKEN']);
  });

  it('demands --scope when no origin remote is inferable', async () => {
    const { deps } = fixture();
    await expect(secretsList(deps, {})).rejects.toThrow(/pass --scope/);
  });

  it('says so when the scope holds no secrets', async () => {
    const { deps, lines } = fixture();
    await expect(secretsList(deps, { scope: 'acme/api' })).resolves.toEqual([]);
    expect(lines.join('\n')).toContain('No secrets in scope acme/api');
  });

  it('enumerates every scope with --all-scopes', async () => {
    const { ssm, deps, lines } = fixture();
    ssm.set('/millwright/prod/secrets/acme/web/OTHER', 'x', 'SecureString');
    ssm.set('/millwright/prod/secrets/acme/api/NPM_TOKEN', 'x', 'SecureString');
    ssm.set('/millwright/prod/secrets/shared/SLACK_HOOK', 'x', 'SecureString');
    ssm.set('/millwright/prod/repos/acme/api/deploy-key', 'KEY', 'SecureString');
    const entries = await secretsList(deps, { allScopes: true });
    expect(entries).toEqual([
      { scope: 'acme/api', name: 'NPM_TOKEN' },
      { scope: 'acme/web', name: 'OTHER' },
      { scope: 'shared', name: 'SLACK_HOOK' },
    ]);
    expect(lines).toEqual([
      'Secrets in every scope (deployment "prod"):',
      'acme/api  NPM_TOKEN',
      'acme/web  OTHER',
      'shared  SLACK_HOOK',
    ]);
  });

  it('does not need an origin remote with --all-scopes', async () => {
    const { deps, lines } = fixture();
    await expect(secretsList(deps, { allScopes: true })).resolves.toEqual([]);
    expect(lines.join('\n')).toContain('No secrets in any scope');
  });
});

describe('secrets rm', () => {
  it('deletes the scoped parameter and reports the path', async () => {
    const { ssm, deps, lines } = fixture();
    ssm.set('/millwright/prod/secrets/acme/api/NPM_TOKEN', 'hunter2', 'SecureString');
    ssm.set('/millwright/prod/secrets/acme/api/AWS_KEY', 'sekrit', 'SecureString');
    await secretsRm(deps, { name: 'NPM_TOKEN', scope: 'acme/api' });
    expect(ssm.parameters.has('/millwright/prod/secrets/acme/api/NPM_TOKEN')).toBe(false);
    expect(ssm.parameters.has('/millwright/prod/secrets/acme/api/AWS_KEY')).toBe(true);
    expect(lines[0]).toBe('Deleted /millwright/prod/secrets/acme/api/NPM_TOKEN (scope acme/api).');
  });

  it('defaults the scope to the repo inferred from the origin remote', async () => {
    const { ssm, deps } = fixture({ inferRepo: async () => 'acme/web' });
    ssm.set('/millwright/prod/secrets/acme/web/DEPLOY_TOKEN', 'x', 'SecureString');
    await secretsRm(deps, { name: 'DEPLOY_TOKEN' });
    expect(ssm.parameters.has('/millwright/prod/secrets/acme/web/DEPLOY_TOKEN')).toBe(false);
  });

  it('fails clearly when the secret does not exist', async () => {
    const { deps } = fixture();
    await expect(secretsRm(deps, { name: 'NPM_TOKEN', scope: 'acme/api' })).rejects.toThrow(
      CommandError,
    );
    await expect(secretsRm(deps, { name: 'NPM_TOKEN', scope: 'acme/api' })).rejects.toThrow(
      /no secret named NPM_TOKEN in scope acme\/api/,
    );
  });

  it('rejects names that cannot be SSM path segments before touching the deployment', async () => {
    // No manifest: discovery would fail, so a rejection proves the pre-check ran first.
    const { deps } = fixture({ ssm: new FakeSsm() });
    await expect(secretsRm(deps, { name: 'not/a/name', scope: 'acme/api' })).rejects.toThrow(
      /not a secret name/,
    );
    await expect(secretsRm(deps, { name: '', scope: 'acme/api' })).rejects.toThrow(CommandError);
  });

  it('demands --scope when no origin remote is inferable', async () => {
    const { deps } = fixture();
    await expect(secretsRm(deps, { name: 'NPM_TOKEN' })).rejects.toThrow(/pass --scope/);
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
