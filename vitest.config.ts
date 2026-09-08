import * as path from 'node:path';
import { defineConfig } from 'vitest/config';

// Resolve workspace-internal imports to sources so tests run on a clean
// checkout, without a prior `npm run build` producing each package's dist.
export default defineConfig({
  // The millwright-cdk construct tests synthesize real stacks, and each first
  // synth in a file bundles ten Lambdas with esbuild (see
  // packages/millwright-cdk/test/support/test-app.ts). That is several
  // seconds on a loaded CI runner — well past vitest's 5 s default.
  test: {
    testTimeout: 30_000,
  },
  resolve: {
    alias: {
      '@copperbox/millwright-state': path.resolve(
        __dirname,
        'packages/millwright-state/src/index.ts',
      ),
      '@copperbox/millwright-workflows': path.resolve(
        __dirname,
        'packages/millwright-workflows/src/index.ts',
      ),
    },
  },
});
