import type { CodeBuildClient } from '@aws-sdk/client-codebuild';
import {
  BatchGetBuildsCommand,
  StartBuildCommand,
  StopBuildCommand,
} from '@aws-sdk/client-codebuild';
import { BuildOutcome, RunModelCompute, RunModelJob } from '@copperbox/millwright-state';
import { BuildRunner, BuildSnapshot, DispatchContext } from './iteration';

/**
 * Per-job dispatch onto the single CodeBuild project (spec §7.4): everything
 * per-run rides `StartBuild` overrides — image, ARM↔x86 environment type,
 * compute size, privileged mode, timeout, and `imagePullCredentialsType:
 * SERVICE_ROLE` (without which job-role ECR grants are inert).
 *
 * The buildspec here is the interim renderer: steps run plainly, without the
 * shim wrap, source unpack, or cache phases. The shared control-plane
 * buildspec library (§7.4, its own issue) replaces `renderInterimBuildspec`
 * wholesale; nothing else in the dispatch path changes. Job-role variant
 * selection at dispatch belongs to the IAM issue and plugs in as a
 * `serviceRoleOverride` when it lands.
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
function computeTypeFor(size: RunModelCompute['size']): string {
  switch (size) {
    case 'large':
      return 'BUILD_GENERAL1_LARGE';
    case 'medium':
      return 'BUILD_GENERAL1_MEDIUM';
    default:
      return 'BUILD_GENERAL1_SMALL';
  }
}

export function renderInterimBuildspec(job: RunModelJob): string {
  return JSON.stringify({
    version: '0.2',
    phases: { build: { commands: job.steps.map((step) => step.run) } },
  });
}

export class CodeBuildRunner implements BuildRunner {
  constructor(
    private readonly client: CodeBuildClient,
    private readonly projectName: string,
  ) {}

  async start(
    job: RunModelJob,
    ctx: DispatchContext,
  ): Promise<{ buildId: string; buildArn?: string }> {
    const environment = [
      { name: 'MILLWRIGHT_RUN_ID', value: ctx.runId, type: 'PLAINTEXT' as const },
      { name: 'MILLWRIGHT_JOB', value: job.name, type: 'PLAINTEXT' as const },
      { name: 'MILLWRIGHT_SHA', value: ctx.sha, type: 'PLAINTEXT' as const },
      { name: 'MILLWRIGHT_REF', value: ctx.ref, type: 'PLAINTEXT' as const },
      ...Object.entries(job.env ?? {}).map(([name, value]) => ({
        name,
        value,
        type: 'PLAINTEXT' as const,
      })),
    ];
    const result = await this.client.send(
      new StartBuildCommand({
        projectName: this.projectName,
        buildspecOverride: renderInterimBuildspec(job),
        sourceTypeOverride: 'NO_SOURCE',
        ...(job.image ? { imageOverride: job.image } : {}),
        environmentTypeOverride:
          job.compute?.arch === 'x86_64' ? 'LINUX_CONTAINER' : 'ARM_CONTAINER',
        computeTypeOverride: computeTypeFor(job.compute?.size),
        privilegedModeOverride: job.privileged === true,
        ...(job.timeoutMinutes ? { timeoutInMinutesOverride: job.timeoutMinutes } : {}),
        imagePullCredentialsTypeOverride: 'SERVICE_ROLE',
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
