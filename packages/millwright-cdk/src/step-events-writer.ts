import { existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { STEP_EVENT_SOURCE } from '@copperbox/millwright-state';
import { Duration } from 'aws-cdk-lib';
import * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
import * as events from 'aws-cdk-lib/aws-events';
import * as targets from 'aws-cdk-lib/aws-events-targets';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import { NodejsFunction, OutputFormat } from 'aws-cdk-lib/aws-lambda-nodejs';
import { Construct } from 'constructs';

export interface StepEventsWriterProps {
  readonly deploymentName: string;
  /** C3 — the bus carrying `millwright.step` events from job-role shims. */
  readonly bus: events.IEventBus;
  /** C9 — where step rows land. */
  readonly stateTable: dynamodb.ITable;
  /** State-table TTL horizon stamped onto step rows. */
  readonly metadataRetention: Duration;
}

/**
 * C19 — the step-events writer (spec §7.8): a Lambda on the deployment bus's
 * `source: millwright.step` rule, projecting shim-emitted step events into
 * step rows idempotent on `(run, job, step-index)`.
 *
 * Its role honors the writer partitioning mechanically: `dynamodb:UpdateItem`
 * on the state table and nothing else — no reads, no query, no streams. The
 * launcher's rule deliberately excludes this source; this rule is the ONLY
 * consumer of `millwright.step`.
 */
export class StepEventsWriter extends Construct {
  readonly fn: NodejsFunction;
  readonly rule: events.Rule;

  constructor(scope: Construct, id: string, props: StepEventsWriterProps) {
    super(scope, id);
    const name = props.deploymentName;

    this.fn = new NodejsFunction(this, 'Fn', {
      description: `millwright (${name}) step events: shim step events to display-plane step rows`,
      entry: runtimeEntry(),
      handler: 'handler',
      runtime: lambda.Runtime.NODEJS_22_X,
      timeout: Duration.seconds(30),
      memorySize: 256,
      environment: {
        STATE_TABLE_NAME: props.stateTable.tableName,
        METADATA_RETENTION_DAYS: String(props.metadataRetention.toDays()),
      },
      bundling: {
        format: OutputFormat.CJS,
        sourcesContent: false,
        esbuildArgs: workspaceAliases(),
      },
    });

    // C19 role (spec §10.3): step-row writes only.
    props.stateTable.grant(this.fn, 'dynamodb:UpdateItem');

    this.rule = new events.Rule(this, 'Rule', {
      eventBus: props.bus,
      description: `millwright (${name}): step events to the step-events writer`,
      eventPattern: { source: [STEP_EVENT_SOURCE] },
      targets: [new targets.LambdaFunction(this.fn)],
    });
  }
}

/** TS sources in the repo; compiled JS in the published package's dist. */
function runtimeEntry(): string {
  const ts = join(__dirname, 'runtime', 'step-events', 'handler.ts');
  return existsSync(ts) ? ts : join(__dirname, 'runtime', 'step-events', 'handler.js');
}

function workspaceAliases(): Record<string, string> | undefined {
  const stateSources = resolve(__dirname, '..', '..', 'millwright-state', 'src', 'index.ts');
  return existsSync(stateSources)
    ? { '--alias:@copperbox/millwright-state': stateSources }
    : undefined;
}
