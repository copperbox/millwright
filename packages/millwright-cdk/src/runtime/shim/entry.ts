import { main } from './main';

/**
 * Executable entry point — what `scripts/build-shim.mjs` bundles into the
 * delivered shim. Kept to one statement so every behavior lives in testable
 * modules.
 */
void main(process.argv.slice(2), process.env).then(
  (code) => process.exit(code),
  (err) => {
    console.error(`millwright-shim: ${(err as Error).stack ?? err}`);
    process.exit(70); // sysexits EX_SOFTWARE
  },
);
