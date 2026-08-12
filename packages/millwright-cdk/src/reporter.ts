import { existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { githubAppParameterName } from '@copperbox/millwright-state';
import { Aws, Duration } from 'aws-cdk-lib';
import * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
import * as events from 'aws-cdk-lib/aws-events';
import * as targets from 'aws-cdk-lib/aws-events-targets';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as kms from 'aws-cdk-lib/aws-kms';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import { DynamoEventSource } from 'aws-cdk-lib/aws-lambda-event-sources';
import { NodejsFunction, OutputFormat } from 'aws-cdk-lib/aws-lambda-nodejs';
import { Construct } from 'constructs';

export interface ReporterProps {
  readonly deploymentName: string;
  /** C9 — must have a stream; the reporter rides its `CHECK#` records. */
  readonly stateTable: dynamodb.ITable;
  /** C14 — decrypts the GitHub credentials SecureString. */
  readonly configKey: kms.IKey;
}

/**
 * C8 — the reporter (spec §13.2): sole owner of check-run reconciliation to
 * GitHub. One function, two triggers: the state table's DynamoDB stream
 * filtered to `CHECK#` partition keys (the happy path — desired-state writes
 * reconcile within seconds) and a 1-minute sweep rule that catches whatever
 * the stream path left unconverged (crashes, expired backoffs, outages).
 *
 * Stream errors retry a bounded number of times and are then dropped rather
 * than blocking the shard: every reconcile is idempotent against the item's
 * latest desired state, so the sweep is always a complete backstop.
 */
export class Reporter extends Construct {
  readonly fn: NodejsFunction;
  readonly sweepRule: events.Rule;
  /** SSM parameter holding the GitHub App/PAT credentials (spec §9.2). */
  readonly credentialsParameterName: string;

  constructor(scope: Construct, id: string, props: ReporterProps) {
    super(scope, id);
    const name = props.deploymentName;
    this.credentialsParameterName = githubAppParameterName(name);

    this.fn = new NodejsFunction(this, 'Fn', {
      description: `millwright (${name}) reporter: check items to GitHub checks/statuses`,
      entry: reporterEntry(),
      handler: 'handler',
      runtime: lambda.Runtime.NODEJS_22_X,
      timeout: Duration.minutes(1),
      memorySize: 256,
      environment: {
        STATE_TABLE_NAME: props.stateTable.tableName,
        GITHUB_CREDENTIALS_PARAMETER: this.credentialsParameterName,
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
      new DynamoEventSource(props.stateTable, {
        startingPosition: lambda.StartingPosition.LATEST,
        batchSize: 100,
        maxBatchingWindow: Duration.seconds(1),
        retryAttempts: 3,
        filters: [
          lambda.FilterCriteria.filter({
            dynamodb: { Keys: { pk: { S: lambda.FilterRule.beginsWith('CHECK#') } } },
          }),
        ],
      }),
    );

    this.sweepRule = new events.Rule(this, 'SweepRule', {
      description: `millwright (${name}): 1-min check reconciliation sweep`,
      schedule: events.Schedule.rate(Duration.minutes(1)),
      targets: [
        new targets.LambdaFunction(this.fn, {
          event: events.RuleTargetInput.fromObject({ sweep: true }),
        }),
      ],
    });

    // Reporter role (spec §11): state table + stream (stream grant comes
    // with the event source), the App credentials parameter, and the CMK
    // that SecureString decryption rides through.
    props.stateTable.grantReadWriteData(this.fn);
    this.fn.addToRolePolicy(
      new iam.PolicyStatement({
        actions: ['ssm:GetParameter'],
        resources: [
          `arn:${Aws.PARTITION}:ssm:${Aws.REGION}:${Aws.ACCOUNT_ID}:parameter${this.credentialsParameterName}`,
        ],
      }),
    );
    props.configKey.grantDecrypt(this.fn);
  }
}

/** TS sources in the repo; compiled JS in the published package's dist. */
function reporterEntry(): string {
  const ts = join(__dirname, 'runtime', 'reporter', 'handler.ts');
  return existsSync(ts) ? ts : join(__dirname, 'runtime', 'reporter', 'handler.js');
}

function workspaceAliases(): Record<string, string> | undefined {
  const stateSources = resolve(__dirname, '..', '..', 'millwright-state', 'src', 'index.ts');
  return existsSync(stateSources)
    ? { '--alias:@copperbox/millwright-state': stateSources }
    : undefined;
}
