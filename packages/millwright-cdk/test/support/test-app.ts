import { mkdtempSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { App, AppProps } from 'aws-cdk-lib';

/**
 * A CDK App for construct tests, with one cloud-assembly outdir shared by every
 * App in this worker process.
 *
 * Synthesizing the Millwright construct bundles ten Lambdas with esbuild (plus
 * the synth tooling bundle), which costs seconds per synth and blew vitest's
 * 5 s per-test budget on the CI runner. aws-cdk-lib's AssetStaging keeps a
 * process-wide cache keyed on (outdir, source, bundling options), but a bare
 * `new App()` picks a fresh temp outdir every time, so nothing ever hits it.
 * Pinning the outdir per process means the first synth in a test file does the
 * bundling and every later synth reuses it.
 *
 * The outdir is not removed afterwards: a bare `new App()` also leaves its temp
 * dir behind, once per App, so this strictly reduces the litter.
 */
let outdir: string | undefined;

export function testApp(props: AppProps = {}): App {
  outdir ??= mkdtempSync(join(realpathSync(tmpdir()), 'millwright-cdk-test-'));
  return new App({ outdir, ...props });
}
