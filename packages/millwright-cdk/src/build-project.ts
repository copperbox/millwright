import { MAX_RUN_DEADLINE_MINUTES, SHIM_PREFIX } from '@copperbox/millwright-state';
import { Duration } from 'aws-cdk-lib';
import * as codebuild from 'aws-cdk-lib/aws-codebuild';
import * as logs from 'aws-cdk-lib/aws-logs';
import * as s3 from 'aws-cdk-lib/aws-s3';
import { Construct } from 'constructs';

export interface BuildProjectProps {
  readonly deploymentName: string;
  /** C12 — sources (run `in/`, shim) and outputs live here. */
  readonly artifactBucket: s3.IBucket;
  /** C17 — one group, one stream per build. */
  readonly buildLogGroup: logs.ILogGroup;
}

/**
 * C11 — the single CodeBuild project every job runs on (spec §7.4): one
 * project for everything, one `StartBuild` per job, with everything
 * job-specific riding per-build overrides from the decider's dispatch —
 * image, ARM↔x86 environment type, compute size, privileged mode, env,
 * timeout, service role, `SERVICE_ROLE` pull credentials, inline buildspec,
 * and the source locations (run `in/` primary, shim secondary).
 *
 * The project itself therefore only pins the invariants: the name the run
 * executor already wired into dispatch and the build-events rule, on-demand
 * EC2 ARM small defaults (§11.3 — reserved capacity is rejected: it violates
 * zero-idle), the 36 h maximum build duration that backs the run-deadline
 * ceiling, and CodeBuild's built-in QUEUED phase as the only queue.
 * CodeBuild-native artifacts and cache modes are unused (§9.3) — artifacts
 * and the keyed cache are buildspec phases against the bucket.
 */
export class BuildProject extends Construct {
  readonly project: codebuild.Project;
  /** `<deploymentName>-builds` — must match the run executor's pinned name. */
  readonly projectName: string;

  constructor(scope: Construct, id: string, props: BuildProjectProps) {
    super(scope, id);
    const name = props.deploymentName;
    this.projectName = `${name}-builds`;

    this.project = new codebuild.Project(this, 'Project', {
      projectName: this.projectName,
      description: `millwright (${name}) builds: every job of every run, via StartBuild overrides`,
      // Default source: the shim delivery prefix. Every dispatch overrides
      // the primary source to the run's in/ prefix and re-attaches the shim
      // as the S3 secondary source, so the default only exists because a
      // project must have one.
      source: codebuild.Source.s3({
        bucket: props.artifactBucket,
        path: SHIM_PREFIX,
      }),
      environment: {
        buildImage: codebuild.LinuxArmBuildImage.AMAZON_LINUX_2023_STANDARD_3_0,
        computeType: codebuild.ComputeType.SMALL,
        privileged: false,
      },
      // The C11 ceiling (spec §7.3/§7.4): per-job timeouts override downward.
      timeout: Duration.minutes(MAX_RUN_DEADLINE_MINUTES),
      queuedTimeout: Duration.hours(8),
      logging: {
        cloudWatch: { logGroup: props.buildLogGroup },
      },
    });
  }
}
