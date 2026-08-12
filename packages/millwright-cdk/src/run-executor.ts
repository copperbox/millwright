import { existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { RUNS_PREFIX } from '@copperbox/millwright-state';
import { Aws, Duration } from 'aws-cdk-lib';
import * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
import * as events from 'aws-cdk-lib/aws-events';
import * as targets from 'aws-cdk-lib/aws-events-targets';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import { NodejsFunction, OutputFormat } from 'aws-cdk-lib/aws-lambda-nodejs';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as sfn from 'aws-cdk-lib/aws-stepfunctions';
import { Construct } from 'constructs';
import { renderRunExecutorDefinition } from './run-executor-definition';

export interface RunExecutorProps {
  readonly deploymentName: string;
  /** C9 — the state table (run/job rows, `BUILD#` items). */
  readonly stateTable: dynamodb.ITable;
  /** C12 — where the decider reads each run's `in/model.json`. */
  readonly artifactBucket: s3.IBucket;
  /** State-table TTL horizon stamped onto decider-written rows. */
  readonly metadataRetention: Duration;
}

/**
 * C5–C7 — the run executor (spec §7.3): the generic Standard state machine
 * (deployed once, executing one run), the decider Lambda wrapping the pure
 * `decide` library from `@copperbox/millwright-state`, and the build-events
 * handler on the default bus's CodeBuild build-state rule.
 *
 * The machine's name honors the `<deploymentName>-run-executor` contract the
 * launcher pinned. Two further physical names are pinned HERE, ahead of the
 * consists that create them — they must use these exact names:
 *
 * - `<deploymentName>-builds` — the CodeBuild project (C11) the decider
 *   dispatches onto and the build-events rule filters on.
 * - `<deploymentName>-synth` / `<deploymentName>-post-synth` — the synth
 *   phase Lambdas the machine invokes. `-synth` receives
 *   `{ taskToken, input }` and must complete the token when the synth build
 *   lands; `-post-synth` validates the model, writes the registry entry and
 *   reports the synth check (spec §7.2).
 */
export class RunExecutor extends Construct {
  /** C6 — the decider Lambda. */
  readonly deciderFn: NodejsFunction;
  /** C7 — the build-events handler. */
  readonly buildEventsFn: NodejsFunction;
  /** The rule on the DEFAULT bus (CodeBuild emits there) feeding C7. */
  readonly buildEventsRule: events.Rule;
  /** C5 — the run executor state machine. */
  readonly stateMachine: sfn.StateMachine;
  /** Machine name, honoring the launcher's pinned contract. */
  readonly stateMachineName: string;
  readonly stateMachineArn: string;
  /** Pinned physical name of the CodeBuild project (C11). */
  readonly buildProjectName: string;
  /** Pinned physical name of the synth-phase Lambda. */
  readonly synthFunctionName: string;
  /** Pinned physical name of the post-synth validation/registry Lambda. */
  readonly postSynthFunctionName: string;

  constructor(scope: Construct, id: string, props: RunExecutorProps) {
    super(scope, id);
    const name = props.deploymentName;

    this.stateMachineName = `${name}-run-executor`;
    this.stateMachineArn = `arn:${Aws.PARTITION}:states:${Aws.REGION}:${Aws.ACCOUNT_ID}:stateMachine:${this.stateMachineName}`;
    this.buildProjectName = `${name}-builds`;
    this.synthFunctionName = `${name}-synth`;
    this.postSynthFunctionName = `${name}-post-synth`;
    const buildProjectArn = `arn:${Aws.PARTITION}:codebuild:${Aws.REGION}:${Aws.ACCOUNT_ID}:project/${this.buildProjectName}`;
    const lambdaArn = (fn: string): string =>
      `arn:${Aws.PARTITION}:lambda:${Aws.REGION}:${Aws.ACCOUNT_ID}:function:${fn}`;
    const synthFunctionArn = lambdaArn(this.synthFunctionName);
    const postSynthFunctionArn = lambdaArn(this.postSynthFunctionName);

    this.deciderFn = new NodejsFunction(this, 'DeciderFn', {
      description: `millwright (${name}) decider: one iteration of the run executor loop`,
      entry: runtimeEntry('run-executor'),
      handler: 'handler',
      runtime: lambda.Runtime.NODEJS_22_X,
      // Above the 60 s wake timeout: an overrunning iteration is cut off by
      // the state's States.Timeout catch (safe — dispatch claims are
      // conditional), never by a hard Lambda timeout failing the state.
      timeout: Duration.seconds(90),
      memorySize: 256,
      environment: {
        STATE_TABLE_NAME: props.stateTable.tableName,
        ARTIFACT_BUCKET_NAME: props.artifactBucket.bucketName,
        BUILD_PROJECT_NAME: this.buildProjectName,
        METADATA_RETENTION_DAYS: String(props.metadataRetention.toDays()),
      },
      bundling: {
        format: OutputFormat.CJS,
        sourcesContent: false,
        esbuildArgs: workspaceAliases(),
      },
    });

    // Decider role (spec §10.3): state table, model reads under runs/,
    // CodeBuild dispatch on the single project, task-token responses. The
    // IAM issue adds role reconciliation with its escalation guards.
    props.stateTable.grantReadWriteData(this.deciderFn);
    props.artifactBucket.grantRead(this.deciderFn, `${RUNS_PREFIX}*`);
    this.deciderFn.addToRolePolicy(
      new iam.PolicyStatement({
        actions: ['codebuild:StartBuild', 'codebuild:StopBuild', 'codebuild:BatchGetBuilds'],
        resources: [buildProjectArn],
      }),
    );
    this.deciderFn.addToRolePolicy(
      new iam.PolicyStatement({
        actions: ['states:SendTaskSuccess', 'states:SendTaskFailure'],
        resources: [this.stateMachineArn],
      }),
    );

    this.stateMachine = new sfn.StateMachine(this, 'StateMachine', {
      stateMachineName: this.stateMachineName,
      stateMachineType: sfn.StateMachineType.STANDARD,
      definitionBody: sfn.DefinitionBody.fromString(
        JSON.stringify(
          renderRunExecutorDefinition({
            deciderFunctionArn: this.deciderFn.functionArn,
            synthFunctionArn,
            postSynthFunctionArn,
            stateMachineArn: this.stateMachineArn,
          }),
        ),
      ),
    });
    this.deciderFn.grantInvoke(this.stateMachine);
    this.stateMachine.addToRolePolicy(
      new iam.PolicyStatement({
        actions: ['lambda:InvokeFunction'],
        resources: [synthFunctionArn, postSynthFunctionArn],
      }),
    );
    // Carry-over: the terminal state starts a fresh execution of this same
    // machine. The ARN is spelled out from the pinned name — referencing the
    // machine's own attribute here would be a self-reference.
    this.stateMachine.addToRolePolicy(
      new iam.PolicyStatement({
        actions: ['states:StartExecution'],
        resources: [this.stateMachineArn],
      }),
    );

    this.buildEventsFn = new NodejsFunction(this, 'BuildEventsFn', {
      description: `millwright (${name}) build events: job-state projection and token wakes`,
      entry: runtimeEntry('build-events'),
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

    // Build-events role (spec §10.3): job-row updates via BUILD# lookup plus
    // the task-token send — nothing more.
    props.stateTable.grantReadWriteData(this.buildEventsFn);
    this.buildEventsFn.addToRolePolicy(
      new iam.PolicyStatement({
        actions: ['states:SendTaskSuccess', 'states:SendTaskFailure'],
        resources: [this.stateMachineArn],
      }),
    );

    // CodeBuild emits build-state events on the DEFAULT bus only; the rule
    // filters to this deployment's pinned project.
    this.buildEventsRule = new events.Rule(this, 'BuildEventsRule', {
      description: `millwright (${name}): CodeBuild build-state changes to the build-events handler`,
      eventPattern: {
        source: ['aws.codebuild'],
        detailType: ['CodeBuild Build State Change'],
        detail: { 'project-name': [this.buildProjectName] },
      },
      targets: [new targets.LambdaFunction(this.buildEventsFn)],
    });
  }
}

/** TS sources in the repo; compiled JS in the published package's dist. */
function runtimeEntry(component: string): string {
  const ts = join(__dirname, 'runtime', component, 'handler.ts');
  return existsSync(ts) ? ts : join(__dirname, 'runtime', component, 'handler.js');
}

function workspaceAliases(): Record<string, string> | undefined {
  const stateSources = resolve(__dirname, '..', '..', 'millwright-state', 'src', 'index.ts');
  return existsSync(stateSources)
    ? { '--alias:@copperbox/millwright-state': stateSources }
    : undefined;
}
