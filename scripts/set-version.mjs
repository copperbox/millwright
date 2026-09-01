#!/usr/bin/env node
// Lockstep version bump: all three packages (and the root) always share one
// version, and the embedded src/version.ts constants track package.json.
//
//   npm run set-version -- 0.2.0

import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const version = process.argv[2];

if (!version || !/^\d+\.\d+\.\d+(-[0-9A-Za-z-.]+)?$/.test(version)) {
  console.error('Usage: npm run set-version -- <semver>');
  process.exit(1);
}

const packageDirs = [
  '.',
  'packages/millwright-state',
  'packages/millwright-workflows',
  'packages/millwright-cdk',
  'packages/millwright-cli',
];

for (const dir of packageDirs) {
  const manifestPath = join(root, dir, 'package.json');
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
  manifest.version = version;
  for (const dep of Object.keys(manifest.dependencies ?? {})) {
    if (dep.startsWith('@copperbox/millwright-')) manifest.dependencies[dep] = `^${version}`;
  }
  writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
  console.log(`${manifest.name} -> ${version}`);

  const versionTs = join(root, dir, 'src', 'version.ts');
  if (existsSync(versionTs)) {
    const source = readFileSync(versionTs, 'utf8').replace(
      /export const VERSION = '[^']*';/,
      `export const VERSION = '${version}';`,
    );
    writeFileSync(versionTs, source);
  }
}
