import * as fs from 'node:fs';
import * as path from 'node:path';
import { SHIM_BINARY_NAME, SHIM_DIR_ENV } from '@copperbox/millwright-state';
import { CommandError } from '../config-plane';

/**
 * Locate the step-shim delivery directory to bind-mount into job containers
 * (spec §11.2/§14): the same `control/shim/` content CodeBuild materializes
 * as a secondary source. Local resolution order:
 *
 * 1. `MILLWRIGHT_SHIM_DIR` — explicit operator override.
 * 2. The millwright-cdk package's built delivery (`dist/shim`), found via
 *    node resolution from this package and via the monorepo layout — this is
 *    where `scripts/build-shim.mjs` places the dispatcher and binaries.
 *
 * Local runs make no AWS calls, so the delivery is never fetched from S3.
 */

export function shimDeliveryCandidates(fromDir: string): string[] {
  const candidates: string[] = [];
  let dir = fromDir;
  for (;;) {
    candidates.push(path.join(dir, 'node_modules', '@copperbox', 'millwright-cdk', 'dist', 'shim'));
    const parent = path.dirname(dir);
    if (parent === dir) {
      break;
    }
    dir = parent;
  }
  // Monorepo checkout: packages/millwright-cli/src/local → packages/millwright-cdk.
  candidates.push(path.resolve(fromDir, '..', '..', '..', 'millwright-cdk', 'dist', 'shim'));
  return candidates;
}

export function resolveShimDir(env: NodeJS.ProcessEnv, fromDir = __dirname): string {
  const explicit = env[SHIM_DIR_ENV];
  if (explicit) {
    if (!fs.existsSync(path.join(explicit, SHIM_BINARY_NAME))) {
      throw new CommandError(
        `$${SHIM_DIR_ENV}=${explicit} does not contain the ${SHIM_BINARY_NAME} dispatcher`,
      );
    }
    return explicit;
  }
  for (const candidate of shimDeliveryCandidates(fromDir)) {
    if (fs.existsSync(path.join(candidate, SHIM_BINARY_NAME))) {
      return candidate;
    }
  }
  throw new CommandError(
    'no step-shim delivery found for local runs — build it with ' +
      `"node scripts/build-shim.mjs" in the millwright-cdk package, or point $${SHIM_DIR_ENV} ` +
      'at a directory holding the shim dispatcher',
  );
}
