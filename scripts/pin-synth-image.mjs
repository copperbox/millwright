#!/usr/bin/env node
// Refresh the synth image digest pin (release-time step, spec §7.2):
// resolves the current multi-arch index digest for the tag in
// packages/millwright-cdk/src/synth-image.ts and rewrites the constant.
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const target = join(
  dirname(fileURLToPath(import.meta.url)),
  '..',
  'packages/millwright-cdk/src/synth-image.ts',
);

const source = readFileSync(target, 'utf8');
const tag = source.match(/SYNTH_IMAGE_TAG = '([^']+)'/)?.[1];
if (!tag) {
  console.error(`Could not find SYNTH_IMAGE_TAG in ${target}`);
  process.exit(1);
}

const tokenResponse = await fetch(
  'https://public.ecr.aws/token/?scope=repository:docker/library/node:pull',
);
const { token } = await tokenResponse.json();
const manifestResponse = await fetch(
  `https://public.ecr.aws/v2/docker/library/node/manifests/${tag}`,
  {
    method: 'HEAD',
    headers: {
      Authorization: `Bearer ${token}`,
      Accept:
        'application/vnd.oci.image.index.v1+json, ' +
        'application/vnd.docker.distribution.manifest.list.v2+json',
    },
  },
);
const digest = manifestResponse.headers.get('docker-content-digest');
if (!manifestResponse.ok || !digest?.startsWith('sha256:')) {
  console.error(`Could not resolve node:${tag} (HTTP ${manifestResponse.status})`);
  process.exit(1);
}

const updated = source.replace(/'sha256:[0-9a-f]{64}'/, `'${digest}'`);
if (updated === source) {
  console.log(`node:${tag} pin already current (${digest})`);
} else {
  writeFileSync(target, updated);
  console.log(`Pinned node:${tag} to ${digest}`);
}
