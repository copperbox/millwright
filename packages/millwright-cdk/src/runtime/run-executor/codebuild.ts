import type { CodeBuildClient } from '@aws-sdk/client-codebuild';
import {
  BatchGetBuildsCommand,
  type ComputeType,
  StartBuildCommand,
  StopBuildCommand,
} from '@aws-sdk/client-codebuild';
import {
  BuildOutcome,
  EVENT_BUS_ENV,
  RunModelCompute,
  RunModelJob,
  SHIM_SOURCE_IDENTIFIER,
  dataPlaneEnvironment,
  isReservedEnvName,
  renderJobBuildspec,
  runInputSourceLocation,
  shimSourceLocation,
} from '@copperbox/millwright-state';
import { BuildRunner, BuildSnapshot, DispatchContext } from './iteration';

/**
 * Per-job dispatch onto the single CodeBuild project (spec §7.4): everything
 * per-run rides `StartBuild` overrides — image, ARM↔x86 environment type,
 * compute size, privileged mode, timeout, service role (once the IAM issue's
 * variant selection supplies one), `imagePullCredentialsType: SERVICE_ROLE`
 * (without which job-role ECR grants are inert), the inline buildspec from
 * the shared control-plane renderer, and the two source locations: the run's
 * `in/` prefix as primary (model + packaged source, materialized by the
 * CodeBuild agent under the build's role) and the shim delivery prefix as
 * the S3 secondary source.
 */

const BATCH_GET_LIMIT = 100;

const OUTCOMES: readonly BuildOutcome[] = [
  'IN_PROGRESS',
  'SUCCEEDED',
  'FAILED',
  'FAULT',
  'TIMED_OUT',
  'STOPPED',
];

/** Unknown statuses are treated as retryable infrastructure faults. */
export function toBuildOutcome(status: string | undefined): BuildOutcome {
  return (OUTCOMES as readonly string[]).includes(status ?? '')
    ? (status as BuildOutcome)
    : 'FAULT';
}

/** Model compute size → CodeBuild compute type; small is the default (§7.4). */
function computeTypeFor(size: RunModelCompute['size']): ComputeType {
  switch (size) {
    case 'large':
      return 'BUILD_GENERAL1_LARGE';
    case 'medium':
      return 'BUILD_GENERAL1_MEDIUM';
    default:
      return 'BUILD_GENERAL1_SMALL';
  }
}

export interface CodeBuildRunnerConfig {
  /** The single project's pinned name, `<deploymentName>-builds`. */
  readonly projectName: string;
  /** The artifact/cache bucket — sources in, artifacts and caches out. */
  readonly bucketName: string;
  /** Roots the SSM paths the renderer resolves secret references to. */
  readonly deploymentName: string;
  /** The deployment bus the shim's step events PutEvents onto (spec §7.8). */
  readonly eventBusName: string;
}

export class CodeBuildRunner implements BuildRunner {
  constructor(
    private readonly client: CodeBuildClient,
    private readonly config: CodeBuildRunnerConfig,
  ) {}

  async start(
    job: RunModelJob,
    ctx: DispatchContext,
  ): Promise<{ buildId: string; buildArn?: string }> {
    const { projectName, bucketName, deploymentName, eventBusName } = this.config;
    // Identity and data-plane roots first; declared env after, minus the
    // reserved namespaces — a definition must not overwrite job identity,
    // agent state or the build role's credentials.
    const environment = [
      { name: 'MILLWRIGHT_RUN_ID', value: ctx.runId },
      { name: 'MILLWRIGHT_JOB', value: job.name },
      { name: 'MILLWRIGHT_SHA', value: ctx.sha },
      { name: 'MILLWRIGHT_REF', value: ctx.ref },
      { name: EVENT_BUS_ENV, value: eventBusName },
      ...Object.entries(dataPlaneEnvironment(ctx.coords, bucketName)).map(([name, value]) => ({
        name,
        value,
      })),
      ...Object.entries(job.env ?? {})
        .filter(([name]) => !isReservedEnvName(name))
        .map(([name, value]) => ({ name, value })),
    ].map((entry) => ({ ...entry, type: 'PLAINTEXT' as const }));

    const result = await this.client.send(
      new StartBuildCommand({
        projectName,
        buildspecOverride: renderJobBuildspec(job, { deploymentName, repo: ctx.coords.repo }),
        sourceTypeOverride: 'S3',
        sourceLocationOverride: runInputSourceLocation(ctx.coords, bucketName),
        secondarySourcesOverride: [
          {
            type: 'S3',
            location: shimSourceLocation(bucketName),
            sourceIdentifier: SHIM_SOURCE_IDENTIFIER,
          },
        ],
        ...(job.image ? { imageOverride: job.image } : {}),
        environmentTypeOverride:
          job.compute?.arch === 'x86_64' ? 'LINUX_CONTAINER' : 'ARM_CONTAINER',
        computeTypeOverride: computeTypeFor(job.compute?.size),
        privilegedModeOverride: job.privileged === true,
        ...(job.timeoutMinutes ? { timeoutInMinutesOverride: job.timeoutMinutes } : {}),
        imagePullCredentialsTypeOverride: 'SERVICE_ROLE',
        ...(ctx.serviceRoleArn ? { serviceRoleOverride: ctx.serviceRoleArn } : {}),
        environmentVariablesOverride: environment,
      }),
    );
    const buildId = result.build?.id;
    if (!buildId) {
      throw new Error(`StartBuild for job "${job.name}" returned no build id`);
    }
    return { buildId, buildArn: result.build?.arn };
  }

  async stop(buildId: string): Promise<void> {
    await this.client.send(new StopBuildCommand({ id: buildId }));
  }

  async getStatuses(buildIds: readonly string[]): Promise<ReadonlyMap<string, BuildSnapshot>> {
    const snapshots = new Map<string, BuildSnapshot>();
    for (let offset = 0; offset < buildIds.length; offset += BATCH_GET_LIMIT) {
      const chunk = buildIds.slice(offset, offset + BATCH_GET_LIMIT);
      const result = await this.client.send(new BatchGetBuildsCommand({ ids: [...chunk] }));
      for (const build of result.builds ?? []) {
        if (!build.id) {
          continue;
        }
        snapshots.set(build.id, {
          outcome: toBuildOutcome(build.buildStatus),
          phase: build.currentPhase,
          logStreamName: build.logs?.streamName,
          startedAt: build.startTime?.toISOString(),
          finishedAt: build.endTime?.toISOString(),
        });
      }
    }
    return snapshots;
  }
}
