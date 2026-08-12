import { describe, expect, it } from 'vitest';
import {
  configPlaneRoot,
  deployKeyParameterName,
  deploymentNameFromManifestParameter,
  githubAppParameterName,
  hostKeysParameterName,
  manifestParameterName,
  repoConfigParameterName,
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
