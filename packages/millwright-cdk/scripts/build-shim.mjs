#!/usr/bin/env node
/**
 * Builds the step-shim delivery (spec C13) into dist/shim/:
 *
 *   millwright-shim             POSIX-sh dispatcher (copied from shim/)
 *   millwright-shim.cjs         esbuild bundle — the node-on-PATH fallback
 *   millwright-shim-linux-x64   Node SEA binary   (with --sea)
 *   millwright-shim-linux-arm64 Node SEA binary   (with --sea)
 *
 * Usage:
 *   node scripts/build-shim.mjs                       # bundle + dispatcher
 *   node scripts/build-shim.mjs --sea host            # + this host's binary
 *   node scripts/build-shim.mjs --sea linux-x64,linux-arm64   # release set
 *
 * The SEA binaries are what makes the "Linux + POSIX shell, nothing more"
 * image contract hold — job images carry no node. They are produced from the
 * official node distribution matching this process's version; the SEA blob
 * is generated once (no snapshot, no code cache) and injected per target, so
 * cross-arch packaging needs no emulation. Non-host targets download the
 * node tarball from nodejs.org, verify it against SHASUMS256.txt, and cache
 * the extracted binary under .shim-cache/ (outside dist/, which npm packs).
 */
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { chmodSync, copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { gunzipSync } from 'node:zlib';
import { build } from 'esbuild';

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const outDir = join(packageRoot, 'dist', 'shim');
// Cache and SEA scratch files live outside dist: `files` lists dist, so
// anything under it would land in the published tarball.
const cacheDir = join(packageRoot, '.shim-cache');

const SEA_FUSE = 'NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2';
const KNOWN_TARGETS = ['linux-x64', 'linux-arm64'];

function hostTarget() {
  if (process.platform !== 'linux') {
    return undefined;
  }
  return { x64: 'linux-x64', arm64: 'linux-arm64' }[process.arch];
}

function parseArgs(argv) {
  const targets = [];
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === '--sea') {
      const value = argv[i + 1];
      if (!value) {
        throw new Error('--sea requires a value: "host" or a comma-list of targets');
      }
      i += 1;
      for (const raw of value.split(',')) {
        const target = raw === 'host' ? hostTarget() : raw;
        if (raw === 'host' && !target) {
          throw new Error(`--sea host: no shim target for ${process.platform}/${process.arch}`);
        }
        if (!KNOWN_TARGETS.includes(target)) {
          throw new Error(`unknown shim target "${raw}" (known: ${KNOWN_TARGETS.join(', ')})`);
        }
        targets.push(target);
      }
    } else {
      throw new Error(`unknown argument "${argv[i]}"`);
    }
  }
  return { targets: [...new Set(targets)] };
}

async function bundle() {
  const entry = join(packageRoot, 'src', 'runtime', 'shim', 'entry.ts');
  const stateSources = resolve(packageRoot, '..', 'millwright-state', 'src', 'index.ts');
  const bundlePath = join(outDir, 'millwright-shim.cjs');
  await build({
    entryPoints: [entry],
    bundle: true,
    platform: 'node',
    target: 'node22',
    format: 'cjs',
    outfile: bundlePath,
    sourcemap: false,
    logLevel: 'silent',
    // In-repo builds resolve the workspace dependency to its sources, like
    // the NodejsFunction bundling and vitest.config.ts do.
    ...(existsSync(stateSources)
      ? { alias: { '@copperbox/millwright-state': stateSources } }
      : {}),
  });
  return bundlePath;
}

/** Minimal ustar walk: extract one member from a gunzipped tarball. */
function extractTarMember(tarBuffer, suffix) {
  let offset = 0;
  while (offset + 512 <= tarBuffer.length) {
    const header = tarBuffer.subarray(offset, offset + 512);
    const name = header.subarray(0, 100).toString('utf8').replace(/\0.*$/, '');
    if (!name) {
      break;
    }
    const size = parseInt(header.subarray(124, 136).toString('utf8').trim(), 8) || 0;
    if (name.endsWith(suffix)) {
      return tarBuffer.subarray(offset + 512, offset + 512 + size);
    }
    offset += 512 + Math.ceil(size / 512) * 512;
  }
  throw new Error(`"${suffix}" not found in tarball`);
}

async function fetchBuffer(url) {
  console.log(`fetching ${url}`);
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`download failed (${response.status}) for ${url}`);
  }
  return Buffer.from(await response.arrayBuffer());
}

/** Check a downloaded dist file against the release's SHASUMS256.txt. */
async function verifySha256(fileName, buffer) {
  const shasums = await fetchBuffer(`https://nodejs.org/dist/${process.version}/SHASUMS256.txt`);
  const line = shasums
    .toString('utf8')
    .split('\n')
    .find((entry) => entry.trim().endsWith(`  ${fileName}`));
  if (!line) {
    throw new Error(`${fileName} not listed in SHASUMS256.txt for ${process.version}`);
  }
  const expected = line.trim().split(/\s+/)[0];
  const actual = createHash('sha256').update(buffer).digest('hex');
  if (actual !== expected) {
    throw new Error(`sha256 mismatch for ${fileName}: expected ${expected}, got ${actual}`);
  }
}

async function nodeBinaryFor(target) {
  const host = hostTarget();
  if (target === host) {
    return readFileSync(process.execPath);
  }
  const name = `node-${process.version}-${target}`;
  const cached = join(cacheDir, `${name}-node`);
  if (existsSync(cached)) {
    return readFileSync(cached);
  }
  const tarball = await fetchBuffer(`https://nodejs.org/dist/${process.version}/${name}.tar.gz`);
  await verifySha256(`${name}.tar.gz`, tarball);
  const binary = extractTarMember(gunzipSync(tarball), `${name}/bin/node`);
  mkdirSync(cacheDir, { recursive: true });
  writeFileSync(cached, binary);
  return binary;
}

async function buildSeaBinaries(bundlePath, targets) {
  // Scratch files live OUTSIDE dist/shim — everything in the delivery dir
  // gets deployed to the bucket verbatim.
  mkdirSync(cacheDir, { recursive: true });
  const configPath = join(cacheDir, 'sea-config.json');
  const blobPath = join(cacheDir, 'sea-blob.blob');
  // No snapshot, no code cache: the blob stays cross-platform, so one blob
  // serves every target binary.
  writeFileSync(
    configPath,
    JSON.stringify({
      main: bundlePath,
      output: blobPath,
      disableExperimentalSEAWarning: true,
    }),
  );
  execFileSync(process.execPath, ['--experimental-sea-config', configPath], {
    stdio: 'inherit',
  });
  const blob = readFileSync(blobPath);
  const { inject } = await import('postject');

  for (const target of targets) {
    const binaryPath = join(outDir, `millwright-shim-${target}`);
    writeFileSync(binaryPath, await nodeBinaryFor(target));
    await inject(binaryPath, 'NODE_SEA_BLOB', blob, { sentinelFuse: SEA_FUSE });
    chmodSync(binaryPath, 0o755);
    console.log(`built ${binaryPath}`);
  }
}

const { targets } = parseArgs(process.argv.slice(2));
mkdirSync(outDir, { recursive: true });

const bundlePath = await bundle();
console.log(`built ${bundlePath}`);

const dispatcher = join(outDir, 'millwright-shim');
copyFileSync(join(packageRoot, 'shim', 'millwright-shim'), dispatcher);
chmodSync(dispatcher, 0o755);
console.log(`built ${dispatcher}`);

if (targets.length > 0) {
  await buildSeaBinaries(bundlePath, targets);
} else {
  console.log('no --sea targets: delivery carries the node-on-PATH fallback only');
}
