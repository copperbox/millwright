import { copyFileSync, existsSync, mkdirSync, readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { SHIM_PREFIX } from '@copperbox/millwright-state';
import { Annotations, DockerImage } from 'aws-cdk-lib';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as s3deploy from 'aws-cdk-lib/aws-s3-deployment';
import { Construct } from 'constructs';
import { buildSync } from 'esbuild';

export interface ShimAssetsProps {
  readonly deploymentName: string;
  /** C12 — the delivery lands under `control/shim/` here. */
  readonly artifactBucket: s3.IBucket;
}

const PACKAGE_ROOT = resolve(__dirname, '..');
const PREBUILT_DIR = join(PACKAGE_ROOT, 'dist', 'shim');
const DISPATCHER = 'millwright-shim';
const BUNDLE = 'millwright-shim.cjs';

/**
 * Stage the shim delivery files into `outputDir`: the committed sh
 * dispatcher, the single-file bundle, and whatever per-arch SEA binaries a
 * `scripts/build-shim.mjs` run produced. A prebuilt `dist/shim` (release
 * builds, or a local `--sea` run) is copied verbatim; otherwise the bundle
 * is built on the spot with esbuild — the dev/test fallback, node-on-PATH
 * images only. Returns the staged SEA targets so callers can surface the
 * difference.
 */
export function stageShimDelivery(outputDir: string): { seaTargets: string[] } {
  mkdirSync(outputDir, { recursive: true });
  if (existsSync(join(PREBUILT_DIR, BUNDLE))) {
    for (const file of readdirSync(PREBUILT_DIR)) {
      copyFileSync(join(PREBUILT_DIR, file), join(outputDir, file));
    }
  } else {
    copyFileSync(join(PACKAGE_ROOT, 'shim', DISPATCHER), join(outputDir, DISPATCHER));
    const entryTs = join(__dirname, 'runtime', 'shim', 'entry.ts');
    const entry = existsSync(entryTs) ? entryTs : join(__dirname, 'runtime', 'shim', 'entry.js');
    const stateSources = resolve(PACKAGE_ROOT, '..', 'millwright-state', 'src', 'index.ts');
    buildSync({
      entryPoints: [entry],
      bundle: true,
      platform: 'node',
      target: 'node22',
      format: 'cjs',
      outfile: join(outputDir, BUNDLE),
      sourcemap: false,
      logLevel: 'silent',
      ...(existsSync(stateSources)
        ? { alias: { '@copperbox/millwright-state': stateSources } }
        : {}),
    });
  }
  const seaTargets = readdirSync(outputDir)
    .filter((file) => file.startsWith(`${DISPATCHER}-`))
    .map((file) => file.slice(DISPATCHER.length + 1));
  return { seaTargets };
}

/**
 * C13 — the step-shim delivery (spec §7.8, §11.2): the shim files, deployed
 * to the artifact bucket under `control/shim/` — exactly where the decider's
 * dispatch already points every build's S3 secondary source, and what the
 * local runner bind-mounts. `control/` sits outside the bucket's lifecycle
 * rules, so the delivery never ages out; each deploy prunes the prefix to
 * the current version.
 */
export class ShimAssets extends Construct {
  readonly deployment: s3deploy.BucketDeployment;

  constructor(scope: Construct, id: string, props: ShimAssetsProps) {
    super(scope, id);

    this.deployment = new s3deploy.BucketDeployment(this, 'Deployment', {
      sources: [
        s3deploy.Source.asset(join(PACKAGE_ROOT, 'shim'), {
          bundling: {
            // Local staging always succeeds; the docker image is the
            // never-used fallback the bundling contract requires.
            image: DockerImage.fromRegistry('public.ecr.aws/docker/library/node:22'),
            local: {
              tryBundle: (outputDir: string): boolean => {
                const { seaTargets } = stageShimDelivery(outputDir);
                if (seaTargets.length === 0) {
                  Annotations.of(this).addWarningV2(
                    '@copperbox/millwright-cdk:shimWithoutBinaries',
                    'The shim delivery carries no per-arch static binaries — only the ' +
                      'node-on-PATH fallback bundle. Jobs whose images lack node will fail ' +
                      'at their first step. Build them with ' +
                      '"node scripts/build-shim.mjs --sea linux-x64,linux-arm64".',
                  );
                }
                return true;
              },
            },
          },
        }),
      ],
      destinationBucket: props.artifactBucket,
      destinationKeyPrefix: SHIM_PREFIX,
    });
  }
}
