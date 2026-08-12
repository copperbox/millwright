import * as path from 'node:path';
import { defineConfig } from 'vitest/config';

// Resolve workspace-internal imports to sources so tests run on a clean
// checkout, without a prior `npm run build` producing each package's dist.
export default defineConfig({
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
