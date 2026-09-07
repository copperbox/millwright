import { afterEach, describe, expect, it } from 'vitest';
import { copyFileSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { applyVersion, checkLockstep, packageDirs, resolveVersion } from './set-version.mjs';

const script = join(import.meta.dirname, 'set-version.mjs');

const names = {
  '.': 'millwright',
  'packages/millwright-state': '@copperbox/millwright-state',
  'packages/millwright-workflows': '@copperbox/millwright-workflows',
  'packages/millwright-cdk': '@copperbox/millwright-cdk',
  'packages/millwright-cli': '@copperbox/millwright-cli',
};

const internalDeps = {
  'packages/millwright-cdk': {
    dependencies: ['@copperbox/millwright-state', '@copperbox/millwright-workflows'],
    devDependencies: ['@copperbox/millwright-cli'],
  },
  'packages/millwright-cli': {
    dependencies: ['@copperbox/millwright-state', '@copperbox/millwright-workflows'],
  },
};

const withVersionTs = new Set(['packages/millwright-cdk', 'packages/millwright-cli']);

const tmpdirs = [];

afterEach(() => {
  for (const dir of tmpdirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

/** Builds a minimal lockstep tree at `version` and returns its root. */
function fixture(version) {
  const root = mkdtempSync(join(tmpdir(), 'set-version-'));
  tmpdirs.push(root);
  for (const dir of packageDirs) {
    mkdirSync(join(root, dir), { recursive: true });
    const manifest = { name: names[dir], version };
    for (const [block, deps] of Object.entries(internalDeps[dir] ?? {})) {
      manifest[block] = Object.fromEntries(deps.map((dep) => [dep, `^${version}`]));
    }
    manifest.devDependencies = { ...(manifest.devDependencies ?? {}), typescript: '^5.7.0' };
    writeFileSync(join(root, dir, 'package.json'), `${JSON.stringify(manifest, null, 2)}\n`);
    if (withVersionTs.has(dir)) {
      mkdirSync(join(root, dir, 'src'), { recursive: true });
      writeFileSync(
        join(root, dir, 'src', 'version.ts'),
        `// Kept in lockstep with package.json by scripts/set-version.mjs — do not edit by hand.\nexport const VERSION = '${version}';\n`,
      );
    }
  }
  return root;
}

function readManifest(root, dir) {
  return JSON.parse(readFileSync(join(root, dir, 'package.json'), 'utf8'));
}

function writeManifest(root, dir, manifest) {
  writeFileSync(join(root, dir, 'package.json'), `${JSON.stringify(manifest, null, 2)}\n`);
}

describe('checkLockstep', () => {
  it('reports no mismatches for a tree in lockstep', () => {
    const root = fixture('0.6.3');
    expect(checkLockstep(root)).toEqual({ version: '0.6.3', mismatches: [] });
  });

  it('names a package whose version drifted from the root', () => {
    const root = fixture('0.6.3');
    const manifest = readManifest(root, 'packages/millwright-cli');
    manifest.version = '0.6.2';
    writeManifest(root, 'packages/millwright-cli', manifest);

    const { mismatches } = checkLockstep(root);
    expect(mismatches).toHaveLength(1);
    expect(mismatches[0]).toContain('packages/millwright-cli/package.json');
    expect(mismatches[0]).toContain('0.6.2');
    expect(mismatches[0]).toContain('0.6.3');
  });

  it('names an internal dependency range that is not ^<root version>', () => {
    const root = fixture('0.6.3');
    const manifest = readManifest(root, 'packages/millwright-cdk');
    manifest.devDependencies['@copperbox/millwright-cli'] = '^0.6.2';
    writeManifest(root, 'packages/millwright-cdk', manifest);

    const { mismatches } = checkLockstep(root);
    expect(mismatches).toHaveLength(1);
    expect(mismatches[0]).toContain('packages/millwright-cdk/package.json');
    expect(mismatches[0]).toContain('devDependencies');
    expect(mismatches[0]).toContain('@copperbox/millwright-cli');
    expect(mismatches[0]).toContain('^0.6.2');
    expect(mismatches[0]).toContain('^0.6.3');
  });

  it('ignores external dependency ranges', () => {
    const root = fixture('0.6.3');
    const manifest = readManifest(root, 'packages/millwright-cdk');
    manifest.devDependencies.typescript = '^0.0.1';
    writeManifest(root, 'packages/millwright-cdk', manifest);
    expect(checkLockstep(root).mismatches).toEqual([]);
  });

  it('names an embedded VERSION constant that drifted', () => {
    const root = fixture('0.6.3');
    writeFileSync(
      join(root, 'packages/millwright-cdk/src/version.ts'),
      "export const VERSION = '0.6.2';\n",
    );

    const { mismatches } = checkLockstep(root);
    expect(mismatches).toHaveLength(1);
    expect(mismatches[0]).toContain('packages/millwright-cdk/src/version.ts');
    expect(mismatches[0]).toContain('0.6.2');
    expect(mismatches[0]).toContain('0.6.3');
  });

  it('lists every mismatch rather than stopping at the first', () => {
    const root = fixture('0.6.3');
    for (const dir of ['packages/millwright-state', 'packages/millwright-workflows']) {
      const manifest = readManifest(root, dir);
      manifest.version = '0.6.2';
      writeManifest(root, dir, manifest);
    }
    writeFileSync(join(root, 'packages/millwright-cli/src/version.ts'), "export const VERSION = '0.5.0';\n");

    const { mismatches } = checkLockstep(root);
    expect(mismatches).toHaveLength(3);
  });
});

describe('applyVersion', () => {
  it('leaves a drifted tree in lockstep at the new version', () => {
    const root = fixture('0.6.2');
    const manifest = readManifest(root, 'packages/millwright-cli');
    manifest.version = '0.5.0';
    writeManifest(root, 'packages/millwright-cli', manifest);

    applyVersion(root, '0.6.3');

    expect(checkLockstep(root)).toEqual({ version: '0.6.3', mismatches: [] });
    expect(readManifest(root, 'packages/millwright-cdk').dependencies['@copperbox/millwright-state']).toBe('^0.6.3');
    expect(readFileSync(join(root, 'packages/millwright-cli/src/version.ts'), 'utf8')).toContain(
      "export const VERSION = '0.6.3';",
    );
  });
});

describe('resolveVersion', () => {
  it('reads npm_package_version only under the version lifecycle', () => {
    const env = { npm_lifecycle_event: 'version', npm_package_version: '1.2.3' };
    expect(resolveVersion([], env)).toBe('1.2.3');
    expect(resolveVersion([], { ...env, npm_lifecycle_event: 'set-version' })).toBeUndefined();
    expect(resolveVersion([], { npm_package_version: '1.2.3' })).toBeUndefined();
    expect(resolveVersion(['0.9.0'], env)).toBe('0.9.0');
  });
});

describe('command line', () => {
  it('rejects a missing or malformed version', () => {
    for (const args of [[], ['1.2']]) {
      const result = spawnSync(process.execPath, [script, ...args], { encoding: 'utf8' });
      expect(result.status, args.join(' ')).toBe(1);
      expect(result.stderr).toContain('Usage:');
    }
  });

  it('ignores npm_package_version outside the version lifecycle', () => {
    const env = { ...process.env, npm_package_version: '1.2.3' };
    delete env.npm_lifecycle_event;
    const result = spawnSync(process.execPath, [script], { encoding: 'utf8', env });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('Usage:');
  });

  it('validates npm_package_version under the version lifecycle', () => {
    const env = { ...process.env, npm_lifecycle_event: 'version', npm_package_version: 'not-a-version' };
    const result = spawnSync(process.execPath, [script], { encoding: 'utf8', env });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('Usage:');
  });

  it('applies npm_package_version under the version lifecycle', () => {
    // The script resolves its tree from its own location, so a copy inside a
    // fixture rewrites the fixture rather than this checkout.
    const root = fixture('0.6.3');
    mkdirSync(join(root, 'scripts'));
    copyFileSync(script, join(root, 'scripts', 'set-version.mjs'));
    const env = { ...process.env, npm_lifecycle_event: 'version', npm_package_version: '0.7.0' };
    const result = spawnSync(process.execPath, [join(root, 'scripts', 'set-version.mjs')], { encoding: 'utf8', env });
    expect(result.stderr).toBe('');
    expect(result.status).toBe(0);
    expect(checkLockstep(root)).toEqual({ version: '0.7.0', mismatches: [] });
  });

  it('rejects --check combined with a version', () => {
    const result = spawnSync(process.execPath, [script, '--check', '1.2.3'], { encoding: 'utf8' });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('Usage:');
  });

  it('passes --check against this repository', () => {
    // The real tree is the one CI guards; this test is the only place the
    // invariant is asserted, so a drift anywhere in the tree fails here.
    const result = spawnSync(process.execPath, [script, '--check'], { encoding: 'utf8' });
    expect(result.stderr).toBe('');
    expect(result.status).toBe(0);
    expect(result.stdout).toMatch(/lockstep at \d+\.\d+\.\d+/);
  });
});
