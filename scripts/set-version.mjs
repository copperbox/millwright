#!/usr/bin/env node
// Lockstep version bump: all four packages (and the root) always share one
// version, every internal @copperbox/millwright-* dependency range is
// ^<version>, and the embedded src/version.ts constants track package.json.
//
//   npm version 0.2.0              # bump everything to 0.2.0 (via the
//                                  # root `version` lifecycle script)
//   npm run set-version -- 0.2.0   # the same bump without npm version
//   npm run set-version -- --check # verify the tree is in lockstep (CI)
//
// Under `npm version` the script takes no argument: npm exports the new
// version as npm_package_version for every lifecycle script on every
// platform, whereas `$npm_package_version` in package.json only expands
// under a POSIX shell (cmd.exe hands it over as a literal).

import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

export const packageDirs = [
  '.',
  'packages/millwright-state',
  'packages/millwright-workflows',
  'packages/millwright-cdk',
  'packages/millwright-cli',
];

const dependencyBlocks = ['dependencies', 'devDependencies', 'peerDependencies', 'optionalDependencies'];
const internalScope = '@copperbox/millwright-';
const versionPattern = /^\d+\.\d+\.\d+(-[0-9A-Za-z-.]+)?$/;
const versionConstant = /export const VERSION = '([^']*)';/;

function readManifest(root, dir) {
  return JSON.parse(readFileSync(join(root, dir, 'package.json'), 'utf8'));
}

function versionTsPath(root, dir) {
  const path = join(root, dir, 'src', 'version.ts');
  return existsSync(path) ? path : undefined;
}

/**
 * Rewrites every manifest and embedded VERSION constant under `root` to
 * `version`. Returns one log line per manifest touched.
 */
export function applyVersion(root, version) {
  const log = [];
  for (const dir of packageDirs) {
    const manifest = readManifest(root, dir);
    manifest.version = version;
    for (const block of dependencyBlocks) {
      for (const dep of Object.keys(manifest[block] ?? {})) {
        if (dep.startsWith(internalScope)) manifest[block][dep] = `^${version}`;
      }
    }
    writeFileSync(join(root, dir, 'package.json'), `${JSON.stringify(manifest, null, 2)}\n`);
    log.push(`${manifest.name} -> ${version}`);

    const versionTs = versionTsPath(root, dir);
    if (versionTs) {
      const source = readFileSync(versionTs, 'utf8').replace(
        versionConstant,
        `export const VERSION = '${version}';`,
      );
      writeFileSync(versionTs, source);
    }
  }
  return log;
}

/**
 * Compares every manifest and embedded VERSION constant under `root` against
 * the root manifest's version. Returns the root version and one line per
 * mismatch; an empty list means the tree is in lockstep.
 */
export function checkLockstep(root) {
  const { version } = readManifest(root, '.');
  const mismatches = [];
  for (const dir of packageDirs) {
    const manifestPath = join(dir, 'package.json');
    const manifest = readManifest(root, dir);
    if (manifest.version !== version) {
      mismatches.push(`${manifestPath}: version is ${manifest.version}, expected ${version}`);
    }
    for (const block of dependencyBlocks) {
      for (const [dep, range] of Object.entries(manifest[block] ?? {})) {
        if (dep.startsWith(internalScope) && range !== `^${version}`) {
          mismatches.push(`${manifestPath}: ${block}.${dep} is ${range}, expected ^${version}`);
        }
      }
    }

    const versionTs = versionTsPath(root, dir);
    if (versionTs) {
      const found = readFileSync(versionTs, 'utf8').match(versionConstant)?.[1];
      if (found !== version) {
        mismatches.push(`${join(dir, 'src', 'version.ts')}: VERSION is ${found ?? 'missing'}, expected ${version}`);
      }
    }
  }
  return { version, mismatches };
}

function usage() {
  console.error('Usage: npm run set-version -- <semver>');
  console.error('       npm run set-version -- --check');
  console.error('       npm version <semver>   (reads npm_package_version)');
  process.exit(1);
}

/**
 * The version to apply: the positional argument, or, when running as npm's
 * `version` lifecycle script, the freshly bumped npm_package_version.
 */
export function resolveVersion(positional, env) {
  if (positional.length > 0) return positional[0];
  if (env.npm_lifecycle_event === 'version') return env.npm_package_version;
  return undefined;
}

function main(args) {
  const root = join(dirname(fileURLToPath(import.meta.url)), '..');
  const check = args.includes('--check');
  const positional = args.filter((arg) => arg !== '--check');
  if (positional.length > 1 || (check && positional.length > 0)) usage();

  if (check) {
    const { version, mismatches } = checkLockstep(root);
    if (mismatches.length > 0) {
      console.error(`Version lockstep broken (root is ${version}):`);
      for (const line of mismatches) console.error(`  ${line}`);
      console.error('Run `npm run set-version -- <semver>` to realign every package.');
      process.exit(1);
    }
    console.log(`All packages in lockstep at ${version}.`);
    return;
  }

  const version = resolveVersion(positional, process.env);
  if (!version || !versionPattern.test(version)) usage();
  for (const line of applyVersion(root, version)) console.log(line);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main(process.argv.slice(2));
}
