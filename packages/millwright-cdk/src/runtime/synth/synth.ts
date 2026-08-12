import {
  deployKeyParameterName,
  hostKeysParameterName,
  repoConfigParameterName,
} from '@copperbox/millwright-state';
import {
  ExecutionInput,
  parseExecutionInput,
} from '../shared/execution-input';
import { synthDestinationPrefix } from '../shared/synth-locations';
import { SYNTH_IMAGE } from '../../synth-image';

/**
 * Synth phase core (spec §7.2): start the synth build on the shared
 * CodeBuild project (C11) with every per-run knob as a StartBuild override.
 * The state machine invokes this Lambda with `waitForTaskToken`; the build
 * carries the token as a plaintext env var and the synth-events completer
 * finishes it when the build lands.
 *
 * The token-as-env-var is deliberate and safe: a Step Functions task token
 * is not a credential — `SendTaskSuccess` demands `states:SendTask*` IAM on
 * the machine, which the synth job role does not carry. The worst a hostile
 * definition can do with its own token is lie about its own synth, and the
 * post-synth step re-validates `model.json` from S3 regardless.
 */

export interface SynthPhaseConfig {
  readonly deploymentName: string;
  /** The single CodeBuild project (C11), `<deploymentName>-builds`. */
  readonly projectName: string;
  /** The synth job role (§10.3) — StartBuild serviceRoleOverride. */
  readonly synthRoleArn: string;
  /** C12 — where `in/` prefixes live. */
  readonly artifactBucketName: string;
  /** C13 — the synth tooling bundle asset (zip). */
  readonly toolsBucketName: string;
  readonly toolsObjectKey: string;
  /** The control plane's supported run-model schemaVersion. */
  readonly schemaCeiling: number;
  /** Deployment poll cadence, for the cron-granularity lint. */
  readonly pollCadenceMinutes: number;
}

export interface SynthPhaseEvent {
  readonly taskToken: string;
  /** The state machine's `$` — the launcher-authored execution input. */
  readonly input: unknown;
}

export interface StartedBuild {
  readonly buildId: string;
  readonly buildArn?: string;
}

export interface SynthBuildStartInput {
  readonly projectName: string;
  readonly buildspecOverride: string;
  readonly sourceTypeOverride: 'S3';
  readonly sourceLocationOverride: string;
  readonly serviceRoleOverride: string;
  readonly imageOverride: string;
  readonly environmentTypeOverride: 'ARM_CONTAINER';
  readonly computeTypeOverride: 'BUILD_GENERAL1_SMALL';
  readonly privilegedModeOverride: boolean;
  readonly imagePullCredentialsTypeOverride: 'CODEBUILD';
  readonly timeoutInMinutesOverride: number;
  readonly environmentVariablesOverride: readonly {
    readonly name: string;
    readonly value: string;
    readonly type: 'PLAINTEXT' | 'PARAMETER_STORE';
  }[];
}

export interface SynthPhaseDeps {
  readonly config: SynthPhaseConfig;
  readonly start: (input: SynthBuildStartInput) => Promise<StartedBuild>;
}

/**
 * Bounded by the state machine's synth-phase timeout (3600 s); the build's
 * own timeout sits just under it so CodeBuild, not the machine, reports the
 * overrun.
 */
const SYNTH_BUILD_TIMEOUT_MINUTES = 55;

/** The buildspec never embeds repo-derived strings: it runs the tool, period. */
export function renderSynthBuildspec(): string {
  return JSON.stringify({
    version: '0.2',
    phases: {
      build: {
        commands: ['node "$CODEBUILD_SRC_DIR/synth-job.bundle.js"'],
      },
    },
  });
}

export async function startSynthBuild(
  deps: SynthPhaseDeps,
  event: SynthPhaseEvent,
): Promise<StartedBuild> {
  const input: ExecutionInput = parseExecutionInput(event.input);
  const { config } = deps;
  const destPrefix = synthDestinationPrefix(input);

  const plaintext = (name: string, value: string) =>
    ({ name, value, type: 'PLAINTEXT' as const });
  const fromParameter = (name: string, value: string) =>
    ({ name, value, type: 'PARAMETER_STORE' as const });

  return deps.start({
    projectName: config.projectName,
    buildspecOverride: renderSynthBuildspec(),
    // The tooling bundle is the PRIMARY source: the build starts inside the
    // control plane's own code, and the watched repo is cloned by that code.
    sourceTypeOverride: 'S3',
    sourceLocationOverride: `${config.toolsBucketName}/${config.toolsObjectKey}`,
    serviceRoleOverride: config.synthRoleArn,
    imageOverride: SYNTH_IMAGE,
    environmentTypeOverride: 'ARM_CONTAINER',
    computeTypeOverride: 'BUILD_GENERAL1_SMALL',
    privilegedModeOverride: false,
    // The image is public; job-role pull credentials would add nothing.
    imagePullCredentialsTypeOverride: 'CODEBUILD',
    timeoutInMinutesOverride: SYNTH_BUILD_TIMEOUT_MINUTES,
    environmentVariablesOverride: [
      plaintext('MILLWRIGHT_TASK_TOKEN', event.taskToken),
      plaintext('MILLWRIGHT_REPO', input.repo),
      plaintext('MILLWRIGHT_REF', input.ref),
      plaintext('MILLWRIGHT_SHA', input.sha),
      plaintext('MILLWRIGHT_DEST_BUCKET', config.artifactBucketName),
      plaintext('MILLWRIGHT_DEST_PREFIX', destPrefix),
      plaintext('MILLWRIGHT_SCHEMA_CEILING', String(config.schemaCeiling)),
      plaintext('MILLWRIGHT_POLL_CADENCE_MINUTES', String(config.pollCadenceMinutes)),
      // Two-gate material resolves inside the build, under the synth job
      // role: the values below are parameter NAMES, not secrets.
      fromParameter(
        'MILLWRIGHT_DEPLOY_KEY',
        deployKeyParameterName(config.deploymentName, input.repo),
      ),
      fromParameter('MILLWRIGHT_HOST_KEYS', hostKeysParameterName(config.deploymentName)),
      fromParameter(
        'MILLWRIGHT_REPO_CONFIG',
        repoConfigParameterName(config.deploymentName, input.repo),
      ),
    ],
  });
}
