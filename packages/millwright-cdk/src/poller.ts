import { existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { POLLER_EVENT_SOURCE } from '@copperbox/millwright-state';
import { Annotations, Aws, Duration } from 'aws-cdk-lib';
import * as cloudwatch from 'aws-cdk-lib/aws-cloudwatch';
import * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as kms from 'aws-cdk-lib/aws-kms';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import { NodejsFunction, OutputFormat } from 'aws-cdk-lib/aws-lambda-nodejs';
import * as scheduler from 'aws-cdk-lib/aws-scheduler';
import { Construct } from 'constructs';
import { DEPLOYMENT_DIMENSION, METRICS_NAMESPACE } from './runtime/poller/metrics';

export interface PollerProps {
  readonly deploymentName: string;
  /** Tick cadence; also sizes the function timeout (≥ 2× the cadence). */
  readonly pollCadence: Duration;
  /** C10 — the polling table this poller owns at runtime. */
  readonly pollingTable: dynamodb.ITable;
  /** C3 — deterministic bus name the diff events are put on. */
  readonly busName: string;
  /**
   * The poller role's PINNED physical name (`<deploymentName>-poller`): the
   * bus resource policy binds `source: millwright.poller` to exactly this
   * role, so it is created here with that name, never auto-generated.
   */
  readonly pollerRoleName: string;
  /** C14 — decrypts the deploy-key SecureStrings (two-gate posture). */
  readonly configKey: kms.IKey;
}

/** Lambda's hard ceiling on function timeout. */
const MAX_TIMEOUT = Duration.minutes(15);

/**
 * C2 — the tier-1 poller (spec §6.1): EventBridge Scheduler (cadence rate +
 * one-minute jitter window) driving a zip-packaged, NON-VPC Lambda. Non-VPC
 * is load-bearing: SSH egress via a NAT gateway (~$32/mo) would dominate the
 * stack's cost. Reserved concurrency 1 self-throttles tick overlap; the
 * sustained-overlap alarm sits on the resulting Throttles metric.
 */
export class Poller extends Construct {
  readonly fn: NodejsFunction;
  readonly role: iam.Role;
  readonly schedule: scheduler.CfnSchedule;
  /** Sustained tick overlap (spec §6.1) — throttles across three windows. */
  readonly overlapAlarm: cloudwatch.Alarm;
  /** The quorum circuit breaker is open (spec §6.3). */
  readonly breakerAlarm: cloudwatch.Alarm;
  /** A confirmed host-key rotation was auto-reconciled (spec §6.1). */
  readonly hostKeyRotationAlarm: cloudwatch.Alarm;

  constructor(scope: Construct, id: string, props: PollerProps) {
    super(scope, id);
    const name = props.deploymentName;

    let timeout = Duration.seconds(props.pollCadence.toSeconds() * 2);
    if (timeout.toSeconds() > MAX_TIMEOUT.toSeconds()) {
      Annotations.of(this).addWarningV2(
        '@copperbox/millwright-cdk:pollerTimeoutClamped',
        `pollCadence ${props.pollCadence.toMinutes()} min wants a ${timeout.toMinutes()} min ` +
          'poller timeout (2× cadence), over Lambda\'s 15 min ceiling — clamping to 15 min.',
      );
      timeout = MAX_TIMEOUT;
    }

    this.role = new iam.Role(this, 'Role', {
      roleName: props.pollerRoleName,
      assumedBy: new iam.ServicePrincipal('lambda.amazonaws.com'),
      description: `millwright (${name}) poller role, the only legal millwright.poller emitter`,
      managedPolicies: [
        iam.ManagedPolicy.fromAwsManagedPolicyName('service-role/AWSLambdaBasicExecutionRole'),
      ],
    });

    this.fn = new NodejsFunction(this, 'Fn', {
      description: `millwright (${name}) tier-1 poller: SSH ls-refs, diff, emit-then-commit`,
      entry: pollerEntry(),
      handler: 'handler',
      runtime: lambda.Runtime.NODEJS_22_X,
      role: this.role,
      timeout,
      memorySize: 512,
      // Overlapping ticks self-throttle instead of racing the polling table.
      reservedConcurrentExecutions: 1,
      // Deliberately no `vpc`: the poller reaches github.com:22 over the
      // public internet straight from the Lambda service network.
      environment: {
        DEPLOYMENT_NAME: name,
        POLLING_TABLE_NAME: props.pollingTable.tableName,
        EVENT_BUS_NAME: props.busName,
        POLL_CADENCE_SECONDS: String(props.pollCadence.toSeconds()),
        POLLER_CONCURRENCY: '8',
      },
      bundling: {
        format: OutputFormat.CJS,
        sourcesContent: false,
        esbuildArgs: {
          ...workspaceAliases(),
          // ssh2's optional native addons (sshcrypto.node, cpu-features) stay
          // unbundled: their try/catch requires miss at runtime and ssh2 takes
          // the pure-JS path the ticket-016 spike validated.
          '--external:*.node': true,
          '--external:cpu-features': true,
        },
      },
    });

    // Poller role (spec §10.3): GetParameters on deploy keys + host-key pins
    // + repo configs + the GitHub App credentials (tier-2 token minting,
    // spec §13.1), polling-table read/write, PutEvents conditioned to source
    // millwright.poller.
    const parameterArn = (suffix: string) =>
      `arn:${Aws.PARTITION}:ssm:${Aws.REGION}:${Aws.ACCOUNT_ID}:parameter/millwright/${name}/${suffix}`;
    this.role.addToPolicy(
      new iam.PolicyStatement({
        sid: 'ConfigPlaneReads',
        actions: ['ssm:GetParameter', 'ssm:GetParameters', 'ssm:GetParametersByPath'],
        resources: [
          parameterArn('repos'),
          parameterArn('repos/*'),
          parameterArn('github/host-keys'),
          parameterArn('github/app'),
        ],
      }),
    );
    props.configKey.grantDecrypt(this.role);
    props.pollingTable.grantReadWriteData(this.role);
    this.role.addToPolicy(
      new iam.PolicyStatement({
        sid: 'EmitAsPollerOnly',
        actions: ['events:PutEvents'],
        resources: [
          `arn:${Aws.PARTITION}:events:${Aws.REGION}:${Aws.ACCOUNT_ID}:event-bus/${props.busName}`,
        ],
        conditions: { StringEquals: { 'events:source': POLLER_EVENT_SOURCE } },
      }),
    );

    const schedulerRole = new iam.Role(this, 'SchedulerRole', {
      assumedBy: new iam.ServicePrincipal('scheduler.amazonaws.com'),
      description: `millwright (${name}): lets the tick schedule invoke the poller`,
    });
    this.fn.grantInvoke(schedulerRole);

    this.schedule = new scheduler.CfnSchedule(this, 'Tick', {
      description: `millwright (${name}) poll tick`,
      scheduleExpression: rateExpression(props.pollCadence),
      // The jitter window (spec §6.1): fleets of deployments don't all hit
      // github.com on the same second.
      flexibleTimeWindow: { mode: 'FLEXIBLE', maximumWindowInMinutes: 1 },
      target: {
        arn: this.fn.functionArn,
        roleArn: schedulerRole.roleArn,
        // A failed tick is never retried — the next tick re-covers it, and
        // retries would just pile throttles onto reserved concurrency 1.
        retryPolicy: { maximumRetryAttempts: 0 },
      },
    });

    const tickMetric = (metricName: string, statistic: string) =>
      new cloudwatch.Metric({
        namespace: METRICS_NAMESPACE,
        metricName,
        dimensionsMap: { [DEPLOYMENT_DIMENSION]: name },
        statistic,
        period: Duration.minutes(5),
      });

    this.overlapAlarm = new cloudwatch.Alarm(this, 'OverlapAlarm', {
      alarmName: `${name}-poller-overlap`,
      alarmDescription:
        'Poll ticks are overlapping their cadence persistently (invocations throttled by ' +
        'reserved concurrency 1). Check last-tick duration; consider a longer pollCadence or ' +
        'schedule sharding by repo prefix.',
      metric: this.fn.metricThrottles({ period: Duration.minutes(5), statistic: 'Sum' }),
      threshold: 2,
      comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_THRESHOLD,
      evaluationPeriods: 3,
      treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
    });

    this.breakerAlarm = new cloudwatch.Alarm(this, 'BreakerAlarm', {
      alarmName: `${name}-poller-circuit-breaker`,
      alarmDescription:
        'The tier-1 polling circuit breaker is open: SSH transport failed for a quorum of ' +
        'repos. Polling is reduced to a decaying canary until transport recovers.',
      metric: tickMetric('CircuitBreakerOpen', 'Maximum'),
      threshold: 1,
      comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_OR_EQUAL_TO_THRESHOLD,
      evaluationPeriods: 1,
      treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
    });

    this.hostKeyRotationAlarm = new cloudwatch.Alarm(this, 'HostKeyRotationAlarm', {
      alarmName: `${name}-poller-host-key-rotation`,
      alarmDescription:
        'GitHub rotated its SSH host key and the poller auto-reconciled after confirming via ' +
        '/meta. Verify the rotation is expected, then run `millwright refresh-host-keys` to ' +
        'refresh the SSM pin itself.',
      metric: tickMetric('HostKeyRotationReconciled', 'Sum'),
      threshold: 1,
      comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_OR_EQUAL_TO_THRESHOLD,
      evaluationPeriods: 1,
      treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
    });
  }
}

function rateExpression(cadence: Duration): string {
  const seconds = cadence.toSeconds();
  if (seconds < 60 || seconds % 60 !== 0) {
    throw new Error(
      `pollCadence must be a whole number of minutes (EventBridge Scheduler rate), ` +
        `got ${seconds} seconds`,
    );
  }
  const minutes = seconds / 60;
  return minutes === 1 ? 'rate(1 minute)' : `rate(${minutes} minutes)`;
}

/** TS sources in the repo; compiled JS in the published package's dist. */
function pollerEntry(): string {
  const ts = join(__dirname, 'runtime', 'poller', 'handler.ts');
  return existsSync(ts) ? ts : join(__dirname, 'runtime', 'poller', 'handler.js');
}

function workspaceAliases(): Record<string, string> | undefined {
  const stateSources = resolve(__dirname, '..', '..', 'millwright-state', 'src', 'index.ts');
  return existsSync(stateSources)
    ? { '--alias:@copperbox/millwright-state': stateSources }
    : undefined;
}
