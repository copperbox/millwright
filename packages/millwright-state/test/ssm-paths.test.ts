import { describe, expect, it } from 'vitest';
import {
  configPlaneRoot,
  deployKeyParameterName,
  deploymentNameFromManifestParameter,
  githubAppParameterName,
  hostKeysParameterName,
  manifestParameterName,
  repoConfigParameterName,
  repoFromConfigParameterName,
  secretFromParameterName,
  secretParameterName,
} from '../src';

const NAME = 'ci-platform';
const REPO = 'copperbox/millwright';

describe('SSM config-plane paths', () => {
  it('builds the spec §9.2 path table', () => {
    expect(configPlaneRoot(NAME)).toBe('/millwright/ci-platform');
    expect(manifestParameterName(NAME)).toBe('/millwright/ci-platform/manifest');
    expect(repoConfigParameterName(NAME, REPO)).toBe(
      '/millwright/ci-platform/repos/copperbox/millwright/config',
    );
    expect(deployKeyParameterName(NAME, REPO)).toBe(
      '/millwright/ci-platform/repos/copperbox/millwright/deploy-key',
    );
    expect(githubAppParameterName(NAME)).toBe('/millwright/ci-platform/github/app');
    expect(hostKeysParameterName(NAME)).toBe('/millwright/ci-platform/github/host-keys');
    expect(secretParameterName(NAME, REPO, 'NPM_TOKEN')).toBe(
      '/millwright/ci-platform/secrets/copperbox/millwright/NPM_TOKEN',
    );
  });

  it('inverts repo-config parameter names for prefix listing', () => {
    expect(repoFromConfigParameterName(NAME, repoConfigParameterName(NAME, REPO))).toBe(REPO);
    expect(repoFromConfigParameterName(NAME, deployKeyParameterName(NAME, REPO))).toBeUndefined();
    expect(repoFromConfigParameterName(NAME, manifestParameterName(NAME))).toBeUndefined();
    expect(repoFromConfigParameterName(NAME, '/millwright/ci-platform/repos//config')).toBeUndefined();
    expect(
      repoFromConfigParameterName('other', repoConfigParameterName(NAME, REPO)),
    ).toBeUndefined();
  });

  it('inverts secret parameter names into scope + name for secrets list', () => {
    expect(secretFromParameterName(NAME, secretParameterName(NAME, REPO, 'NPM_TOKEN'))).toEqual({
      scope: REPO,
      name: 'NPM_TOKEN',
    });
    expect(secretFromParameterName(NAME, secretParameterName(NAME, 'shared', 'HOOK'))).toEqual({
      scope: 'shared',
      name: 'HOOK',
    });
    expect(secretFromParameterName(NAME, deployKeyParameterName(NAME, REPO))).toBeUndefined();
    expect(secretFromParameterName(NAME, '/millwright/ci-platform/secrets/NPM_TOKEN')).toBeUndefined();
    expect(secretFromParameterName(NAME, '/millwright/ci-platform/secrets//X')).toBeUndefined();
    expect(secretFromParameterName(NAME, '/millwright/ci-platform/secrets/a/')).toBeUndefined();
    expect(
      secretFromParameterName('other', secretParameterName(NAME, REPO, 'NPM_TOKEN')),
    ).toBeUndefined();
  });

  it('inverts manifest parameter names for CLI discovery', () => {
    expect(deploymentNameFromManifestParameter(manifestParameterName(NAME))).toBe(NAME);
    expect(deploymentNameFromManifestParameter('/millwright/x/repos/a/b/config')).toBeUndefined();
    expect(deploymentNameFromManifestParameter('/other/x/manifest')).toBeUndefined();
  });

  it('rejects segments that would escape or corrupt the tree', () => {
    expect(() => configPlaneRoot('has space')).toThrow();
    expect(() => configPlaneRoot('a/b')).toThrow();
    expect(() => repoConfigParameterName(NAME, '/leading')).toThrow();
    expect(() => secretParameterName(NAME, REPO, 'A/B')).toThrow();
    expect(() => secretParameterName(NAME, '', 'NPM_TOKEN')).toThrow();
  });
});
