import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import * as fs from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { RUNS_PREFIX } from '@copperbox/millwright-state';
import { Aws, DockerImage, Duration } from 'aws-cdk-lib';
import * as codebuild from 'aws-cdk-lib/aws-codebuild';
import * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
import * as events from 'aws-cdk-lib/aws-events';
import * as targets from 'aws-cdk-lib/aws-events-targets';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as kms from 'aws-cdk-lib/aws-kms';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import { NodejsFunction, OutputFormat } from 'aws-cdk-lib/aws-lambda-nodejs';
import * as logs from 'aws-cdk-lib/aws-logs';
import * as s3 from 'aws-cdk-lib/aws-s3';
import { Asset } from 'aws-cdk-lib/aws-s3-assets';
import { Construct } from 'constructs';
import { SUPPORTED_SCHEMA_VERSION } from './version';

export interface SynthJobProps {
  readonly deploymentName: string;
  /** C9 — post-synth writes REG# registry entries and CHECK# desired state. */
  readonly stateTable: dynamodb.ITable;
  /** C12 — synth writes `in/`, post-synth reads `model.json` back. */
  readonly artifactBucket: s3.IBucket;
  /** C14 — deploy keys are SecureStrings under this key. */
  readonly configKey: kms.IKey;
  /** C17 — every build streams here, the synth build included. */
  readonly buildLogGroup: logs.ILogGroup;
  /** Stamped onto post-synth's CHECK# rows. */
  readonly metadataRetention: Duration;
  /** Feeds the synth-time cron-granularity lint. */
  readonly pollCadence: Duration;
}

/**
 * The synth job and post-synth step (spec §7.2, §8.3) — the run executor's
 * first phase, with C11 (the single CodeBuild project) and C13's synth
 * tooling bundle.
 *
 * Physical names honored/pinned here:
 *
 * - `<deploymentName>-builds` — C11, the name the run executor pinned (its
 *   issue). Synth builds and user-job builds share it; everything per-build
 *   rides StartBuild overrides.
 * - `<deploymentName>-synth` / `<deploymentName>-post-synth` — the Lambda
 *   names the run executor's machine invokes (contract pinned by its issue,
 *   implementations owned here).
 * - `<deploymentName>-run-executor` — the machine (launcher-pinned) whose
 *   task tokens the synth-events completer finishes.
 * - `<deploymentName>-synth-job` — the synth build's service role (§10.3):
 *   deploy-key + host-key-pin + repo-config reads, PutObject on `in/`
 *   subprefixes, and deliberately NO DynamoDB — the registry entry can only
 *   appear via post-synth validation.
 */
export class SynthJob extends Construct {
  /** C11 — the single CodeBuild project, shared by synth and user jobs. */
  readonly buildProject: codebuild.Project;
  readonly buildProjectName: string;
  /** The synth build's service role (StartBuild serviceRoleOverride). */
  readonly synthJobRole: iam.Role;
  /** The synth phase Lambda (pinned name `<deploymentName>-synth`). */
  readonly synthFn: NodejsFunction;
  readonly synthFunctionName: string;
  /** The post-synth validation/registry Lambda (pinned name). */
  readonly postSynthFn: NodejsFunction;
  readonly postSynthFunctionName: string;
  /** The synth-events token completer. */
  readonly synthEventsFn: NodejsFunction;
  /** The rule feeding terminal build states to the completer. */
  readonly synthEventsRule: events.Rule;
  /** C13 — the synth tooling bundle, the synth build's primary source. */
  readonly toolsAsset: Asset;
  /** ARN of the launcher-pinned run executor machine. */
  readonly runExecutorArn: string;

  constructor(scope: Construct, id: string, props: SynthJobProps) {
    super(scope, id);
    const name = props.deploymentName;

    this.buildProjectName = `${name}-builds`;
    this.synthFunctionName = `${name}-synth`;
    this.postSynthFunctionName = `${name}-post-synth`;
    this.runExecutorArn = `arn:${Aws.PARTITION}:states:${Aws.REGION}:${Aws.ACCOUNT_ID}:stateMachine:${name}-run-executor`;

    // C13: the esbuild-bundled synth tool from millwright-cli's dist, staged
    // as a CDK asset. It reaches the build as the PRIMARY S3 source — the
    // synth tooling is always the control plane's own version (spec §7.2).
    this.toolsAsset = new Asset(this, 'SynthTools', {
      // The dist directory is the staging input; bundling narrows the zip to
      // exactly the synth tool so unrelated dist files never ride along.
      path: dirname(synthToolsBundlePath()),
      bundling: {
        // Local copy always succeeds; the docker image is the never-used
        // fallback the bundling contract requires.
        image: DockerImage.fromRegistry('public.ecr.aws/docker/library/node:22'),
        local: {
          tryBundle(outputDir: string): boolean {
            fs.copyFileSync(
              synthToolsBundlePath(),
              join(outputDir, 'synth-job.bundle.js'),
            );
            return true;
          },
        },
      },
    });

    // The synth build's service role. Deliberately NOT the project default:
    // the synth Lambda passes it per-build via serviceRoleOverride, and user
    // jobs get their own stable role pair (the IAM issue).
    this.synthJobRole = new iam.Role(this, 'SynthJobRole', {
      roleName: `${name}-synth-job`,
      assumedBy: new iam.ServicePrincipal('codebuild.amazonaws.com'),
      description:
        `millwright (${name}) synth job: deploy-key/host-key/config reads and in/ writes; ` +
        'no DynamoDB, ever',
    });
    this.synthJobRole.addToPolicy(
      new iam.PolicyStatement({
        // GetParameters (plural) is what CodeBuild's PARAMETER_STORE env
        // resolution calls; the singular covers ad-hoc reads by the tool.
        actions: ['ssm:GetParameter', 'ssm:GetParameters'],
        resources: [
          `arn:${Aws.PARTITION}:ssm:${Aws.REGION}:${Aws.ACCOUNT_ID}:parameter/millwright/${name}/repos/*`,
          `arn:${Aws.PARTITION}:ssm:${Aws.REGION}:${Aws.ACCOUNT_ID}:parameter/millwright/${name}/github/host-keys`,
        ],
      }),
    );
    // Second gate on the SecureString deploy keys (spec §9.2).
    props.configKey.grantDecrypt(this.synthJobRole);
    this.synthJobRole.addToPolicy(
      new iam.PolicyStatement({
        // Spec §7.2: PutObject on in/ subprefixes only. The stable role
        // spans runs, so the confinement is to the in/ shape — user jobs
        // can never assume this role, and in/ is control-plane input space.
        actions: ['s3:PutObject'],
        resources: [props.artifactBucket.arnForObjects(`${RUNS_PREFIX}*/in/*`)],
      }),
    );
    this.toolsAsset.grantRead(this.synthJobRole);
    props.buildLogGroup.grant(
      this.synthJobRole,
      'logs:CreateLogStream',
      'logs:PutLogEvents',
    );

    // C11. The project-level buildspec is a tripwire: every real build —
    // synth or user job — arrives with buildspecOverride.
    this.buildProject = new codebuild.Project(this, 'BuildProject', {
      projectName: this.buildProjectName,
      description: `millwright (${name}) builds: synth jobs and user jobs, everything via StartBuild overrides`,
      buildSpec: codebuild.BuildSpec.fromObject({
        version: '0.2',
        phases: {
          build: {
            commands: ['echo "millwright starts builds with explicit overrides only" && exit 1'],
          },
        },
      }),
      environment: {
        buildImage: codebuild.LinuxArmBuildImage.AMAZON_LINUX_2_STANDARD_3_0,
        computeType: codebuild.ComputeType.SMALL,
      },
      logging: {
        cloudWatch: { logGroup: props.buildLogGroup },
      },
    });

    this.synthFn = new NodejsFunction(this, 'SynthFn', {
      functionName: this.synthFunctionName,
      description: `millwright (${name}) synth phase: starts the synth build at the triggering commit`,
      entry: runtimeEntry('synth'),
      handler: 'handler',
      runtime: lambda.Runtime.NODEJS_22_X,
      timeout: Duration.seconds(30),
      memorySize: 256,
      environment: {
        DEPLOYMENT_NAME: name,
        BUILD_PROJECT_NAME: this.buildProjectName,
        SYNTH_JOB_ROLE_ARN: this.synthJobRole.roleArn,
        ARTIFACT_BUCKET_NAME: props.artifactBucket.bucketName,
        SYNTH_TOOLS_BUCKET: this.toolsAsset.s3BucketName,
        SYNTH_TOOLS_KEY: this.toolsAsset.s3ObjectKey,
        SCHEMA_CEILING: String(SUPPORTED_SCHEMA_VERSION),
        POLL_CADENCE_MINUTES: String(Math.max(1, Math.round(props.pollCadence.toMinutes()))),
      },
      bundling: {
        format: OutputFormat.CJS,
        sourcesContent: false,
        esbuildArgs: workspaceAliases(),
      },
    });
    this.synthFn.addToRolePolicy(
      new iam.PolicyStatement({
        actions: ['codebuild:StartBuild'],
        resources: [this.buildProject.projectArn],
      }),
    );
    this.synthFn.addToRolePolicy(
      new iam.PolicyStatement({
        actions: ['iam:PassRole'],
        resources: [this.synthJobRole.roleArn],
        conditions: {
          StringEquals: { 'iam:PassedToService': 'codebuild.amazonaws.com' },
        },
      }),
    );

    this.postSynthFn = new NodejsFunction(this, 'PostSynthFn', {
      functionName: this.postSynthFunctionName,
      description: `millwright (${name}) post-synth: model validation, registry write, synth check`,
      entry: runtimeEntry('post-synth'),
      handler: 'handler',
      runtime: lambda.Runtime.NODEJS_22_X,
      timeout: Duration.seconds(60),
      memorySize: 256,
      environment: {
        STATE_TABLE_NAME: props.stateTable.tableName,
        ARTIFACT_BUCKET_NAME: props.artifactBucket.bucketName,
        SCHEMA_CEILING: String(SUPPORTED_SCHEMA_VERSION),
        METADATA_RETENTION_DAYS: String(props.metadataRetention.toDays()),
      },
      bundling: {
        format: OutputFormat.CJS,
        sourcesContent: false,
        esbuildArgs: workspaceAliases(),
      },
    });
    // Post-synth writes REG# and CHECK# rows; reads model.json under runs/.
    props.stateTable.grantWriteData(this.postSynthFn);
    props.artifactBucket.grantRead(this.postSynthFn, `${RUNS_PREFIX}*`);

    this.synthEventsFn = new NodejsFunction(this, 'SynthEventsFn', {
      description: `millwright (${name}) synth events: completes synth task tokens from terminal builds`,
      entry: runtimeEntry('synth-events'),
      handler: 'handler',
      runtime: lambda.Runtime.NODEJS_22_X,
      timeout: Duration.seconds(30),
      memorySize: 256,
      bundling: {
        format: OutputFormat.CJS,
        sourcesContent: false,
        esbuildArgs: workspaceAliases(),
      },
    });
    this.synthEventsFn.addToRolePolicy(
      new iam.PolicyStatement({
        actions: ['states:SendTaskSuccess', 'states:SendTaskFailure'],
        resources: [this.runExecutorArn],
      }),
    );
    // Best-effort synth-error.json reads for real failure causes.
    props.artifactBucket.grantRead(this.synthEventsFn, `${RUNS_PREFIX}*`);

    // CodeBuild emits on the DEFAULT bus. Terminal states only: the token
    // wait doesn't care about IN_PROGRESS, and user-job builds are filtered
    // inside the handler by the absence of a synth task token.
    this.synthEventsRule = new events.Rule(this, 'SynthEventsRule', {
      description: `millwright (${name}): terminal build states to the synth token completer`,
      eventPattern: {
        source: ['aws.codebuild'],
        detailType: ['CodeBuild Build State Change'],
        detail: {
          'project-name': [this.buildProjectName],
          'build-status': ['SUCCEEDED', 'FAILED', 'FAULT', 'TIMED_OUT', 'STOPPED'],
        },
      },
      targets: [new targets.LambdaFunction(this.synthEventsFn)],
    });
  }
}

/** TS sources in the repo; compiled JS in the published package's dist. */
function runtimeEntry(component: string): string {
  const ts = join(__dirname, 'runtime', component, 'handler.ts');
  return existsSync(ts) ? ts : join(__dirname, 'runtime', component, 'handler.js');
}

function workspaceAliases(): Record<string, string> | undefined {
  const aliases: Record<string, string> = {};
  for (const pkg of ['millwright-state', 'millwright-workflows']) {
    const sources = resolve(__dirname, '..', '..', pkg, 'src', 'index.ts');
    if (existsSync(sources)) {
      aliases[`--alias:@copperbox/${pkg}`] = sources;
    }
  }
  return Object.keys(aliases).length > 0 ? aliases : undefined;
}

/**
 * The synth tooling bundle from the lockstep millwright-cli package. The
 * published package always ships dist/synth-job.bundle.js; on a repo
 * checkout that has not run the build yet, bundle it once from sources so
 * tests and dev synth work without a prior `npm run build`.
 */
function synthToolsBundlePath(): string {
  const cliPackageDir = dirname(require.resolve('@copperbox/millwright-cli/package.json'));
  const bundle = join(cliPackageDir, 'dist', 'synth-job.bundle.js');
  if (existsSync(bundle)) {
    return bundle;
  }
  const entry = join(cliPackageDir, 'src', 'synth-job', 'main.ts');
  if (!existsSync(entry)) {
    throw new Error(
      `The synth tooling bundle is missing at ${bundle} and there are no sources to build ` +
        'it from — reinstall @copperbox/millwright-cli',
    );
  }
  execFileSync(process.execPath, [
    require.resolve('esbuild/bin/esbuild'),
    entry,
    '--bundle',
    '--platform=node',
    '--target=node22',
    `--outfile=${bundle}`,
    '--log-level=warning',
  ]);
  return bundle;
}
