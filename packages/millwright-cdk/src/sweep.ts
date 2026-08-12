import { existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { Duration } from 'aws-cdk-lib';
import * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
import * as events from 'aws-cdk-lib/aws-events';
import * as targets from 'aws-cdk-lib/aws-events-targets';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import { NodejsFunction, OutputFormat } from 'aws-cdk-lib/aws-lambda-nodejs';
import { Construct } from 'constructs';

export interface SweepProps {
  readonly deploymentName: string;
  /** C9 — where `GROUP#` slots and run records live. */
  readonly stateTable: dynamodb.ITable;
  /** C5 — the machine the repair hand-off starts pending runs on. */
  readonly runExecutorArn: string;
  /** State-table TTL horizon stamped onto refreshed group slots. */
  readonly metadataRetention: Duration;
}

/**
 * C16 — the sweep (spec §8.4): a Lambda on the 1-minute scheduler that
 * detects concurrency groups whose running run is terminal but whose slot
 * never cleared — a decider that died between run completion and its release
 * — and re-runs the shared release convergence: start the pending run, hand
 * the slot over. It repairs group slots; it never resurrects executions.
 *
 * Overlapping ticks are safe (every repair write is conditional), so the
 * schedule needs no concurrency cap.
 */
export class Sweep extends Construct {
  readonly fn: NodejsFunction;
  readonly rule: events.Rule;

  constructor(scope: Construct, id: string, props: SweepProps) {
    super(scope, id);
    const name = props.deploymentName;

    this.fn = new NodejsFunction(this, 'Fn', {
      description: `millwright (${name}) sweep: concurrency-group slot repair`,
      entry: runtimeEntry(),
      handler: 'handler',
      runtime: lambda.Runtime.NODEJS_22_X,
      // Under the 1-minute cadence: a tick that cannot finish its scan in
      // time gives way to the next one re-running the same convergence.
      timeout: Duration.seconds(55),
      memorySize: 256,
      environment: {
        STATE_TABLE_NAME: props.stateTable.tableName,
        RUN_EXECUTOR_ARN: props.runExecutorArn,
        METADATA_RETENTION_DAYS: String(props.metadataRetention.toDays()),
      },
      bundling: {
        format: OutputFormat.CJS,
        sourcesContent: false,
        esbuildArgs: workspaceAliases(),
      },
    });

    // Sweep role (spec §10.3): the group scan, run reads and conditional
    // slot writes, plus starting pending runs — decider-equivalent hand-off.
    props.stateTable.grantReadWriteData(this.fn);
    this.fn.addToRolePolicy(
      new iam.PolicyStatement({
        actions: ['states:StartExecution'],
        resources: [props.runExecutorArn],
      }),
    );

    this.rule = new events.Rule(this, 'Rule', {
      description: `millwright (${name}): 1-minute sweep tick`,
      schedule: events.Schedule.rate(Duration.minutes(1)),
      targets: [new targets.LambdaFunction(this.fn)],
    });
  }
}

/** TS sources in the repo; compiled JS in the published package's dist. */
function runtimeEntry(): string {
  const ts = join(__dirname, 'runtime', 'sweep', 'handler.ts');
  return existsSync(ts) ? ts : join(__dirname, 'runtime', 'sweep', 'handler.js');
}

function workspaceAliases(): Record<string, string> | undefined {
  const stateSources = resolve(__dirname, '..', '..', 'millwright-state', 'src', 'index.ts');
  return existsSync(stateSources)
    ? { '--alias:@copperbox/millwright-state': stateSources }
    : undefined;
}
