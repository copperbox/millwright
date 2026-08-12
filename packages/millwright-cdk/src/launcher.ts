import { existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { RUNS_PREFIX } from '@copperbox/millwright-state';
import { Aws, Duration } from 'aws-cdk-lib';
import * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
import * as events from 'aws-cdk-lib/aws-events';
import * as targets from 'aws-cdk-lib/aws-events-targets';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import { SqsEventSource } from 'aws-cdk-lib/aws-lambda-event-sources';
import { NodejsFunction, OutputFormat } from 'aws-cdk-lib/aws-lambda-nodejs';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as sqs from 'aws-cdk-lib/aws-sqs';
import { Construct } from 'constructs';

export interface LauncherProps {
  readonly deploymentName: string;
  /** C3 — the bus whose trigger events this launcher consumes. */
  readonly bus: events.IEventBus;
  /** C9 — the state table (counter, runs, processing records, group claims). */
  readonly stateTable: dynamodb.ITable;
  /** C12 — the §7.7 rerun prefix-copy source and destination. */
  readonly artifactBucket: s3.IBucket;
  /** State-table TTL horizon stamped onto launcher-written rows. */
  readonly metadataRetention: Duration;
}

/**
 * C4 — the launcher (spec §7.1): consumes trigger events from the bus and
 * turns them into runs, in the pinned order validate → dedupe → match →
 * counter → run record → gate → StartExecution.
 *
 * Delivery is rule → SQS → Lambda rather than a direct Lambda target: a
 * failed record returns to the queue and redelivers after the visibility
 * timeout, which is the crash-recovery path AND the bootstrap replay
 * mechanism (a first-push event waits in the queue while its bootstrap synth
 * populates the registry). Queue retention mirrors EventBridge's 24 h retry
 * ceiling.
 *
 * The run executor's name is pinned HERE as `<deploymentName>-run-executor`,
 * ahead of the issue that builds the state machine — it must use this exact
 * name; the launcher's grant and environment already point at it.
 */
export class Launcher extends Construct {
  readonly queue: sqs.Queue;
  readonly rule: events.Rule;
  readonly fn: NodejsFunction;
  /** Pinned physical name of the run-executor state machine. */
  readonly runExecutorName: string;
  /** ARN the launcher starts executions on (grant + env, pre-wired). */
  readonly runExecutorArn: string;

  constructor(scope: Construct, id: string, props: LauncherProps) {
    super(scope, id);
    const name = props.deploymentName;

    this.runExecutorName = `${name}-run-executor`;
    this.runExecutorArn = `arn:${Aws.PARTITION}:states:${Aws.REGION}:${Aws.ACCOUNT_ID}:stateMachine:${this.runExecutorName}`;

    this.queue = new sqs.Queue(this, 'Queue', {
      queueName: `${name}-launcher`,
      retentionPeriod: Duration.hours(24),
      // Must exceed the function timeout; also sets the redelivery cadence
      // that bootstrap replays ride on.
      visibilityTimeout: Duration.minutes(2),
      enforceSSL: true,
    });

    this.rule = new events.Rule(this, 'Rule', {
      eventBus: props.bus,
      description: `millwright (${name}): trigger events to the launcher`,
      eventPattern: {
        // millwright.step events belong to the step-events writer, not here.
        source: ['millwright.poller', 'millwright.cli'],
        detailType: ['push', 'branch', 'tag', 'pr', 'cron', 'dispatch', 'bootstrap', 'rerun'],
      },
      targets: [new targets.SqsQueue(this.queue)],
    });

    this.fn = new NodejsFunction(this, 'Fn', {
      description: `millwright (${name}) launcher: bus events to runs`,
      entry: launcherEntry(),
      handler: 'handler',
      runtime: lambda.Runtime.NODEJS_22_X,
      timeout: Duration.seconds(30),
      memorySize: 256,
      environment: {
        STATE_TABLE_NAME: props.stateTable.tableName,
        RUN_EXECUTOR_ARN: this.runExecutorArn,
        ARTIFACT_BUCKET_NAME: props.artifactBucket.bucketName,
        METADATA_RETENTION_DAYS: String(props.metadataRetention.toDays()),
      },
      bundling: {
        format: OutputFormat.CJS,
        sourcesContent: false,
        // In-repo dev resolves the workspace dependency to its sources, the
        // same way vitest.config.ts aliases it — the published package
        // resolves it from node_modules like any other dependency.
        esbuildArgs: workspaceAliases(),
      },
    });
    this.fn.addEventSource(
      new SqsEventSource(this.queue, { batchSize: 10, reportBatchItemFailures: true }),
    );

    // Launcher role (spec §10.4): its own state-table partition, S3 across
    // runs/* for the rerun prefix-copy, StartExecution on the run executor.
    props.stateTable.grantReadWriteData(this.fn);
    props.artifactBucket.grantReadWrite(this.fn, `${RUNS_PREFIX}*`);
    this.fn.addToRolePolicy(
      new iam.PolicyStatement({
        actions: ['states:StartExecution'],
        resources: [this.runExecutorArn],
      }),
    );
  }
}

/** TS sources in the repo; compiled JS in the published package's dist. */
function launcherEntry(): string {
  const ts = join(__dirname, 'runtime', 'launcher', 'handler.ts');
  return existsSync(ts) ? ts : join(__dirname, 'runtime', 'launcher', 'handler.js');
}

function workspaceAliases(): Record<string, string> | undefined {
  const stateSources = resolve(__dirname, '..', '..', 'millwright-state', 'src', 'index.ts');
  return existsSync(stateSources)
    ? { '--alias:@copperbox/millwright-state': stateSources }
    : undefined;
}
