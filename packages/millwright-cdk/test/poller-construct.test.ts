import { App, Duration, Stack } from 'aws-cdk-lib';
import { Annotations, Match, Template } from 'aws-cdk-lib/assertions';
import * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
import * as kms from 'aws-cdk-lib/aws-kms';
import { describe, expect, it } from 'vitest';
import { MillwrightEventBus, Poller } from '../src';

function synth(pollCadence = Duration.minutes(1)): {
  poller: Poller;
  stack: Stack;
  template: Template;
} {
  const stack = new Stack(new App(), 'Test');
  const bus = new MillwrightEventBus(stack, 'EventBus', { deploymentName: 'ci' });
  const poller = new Poller(stack, 'Poller', {
    deploymentName: 'ci',
    pollCadence,
    pollingTable: new dynamodb.Table(stack, 'PollingTable', {
      partitionKey: { name: 'pk', type: dynamodb.AttributeType.STRING },
      sortKey: { name: 'sk', type: dynamodb.AttributeType.STRING },
    }),
    stateTable: new dynamodb.Table(stack, 'StateTable', {
      partitionKey: { name: 'pk', type: dynamodb.AttributeType.STRING },
      sortKey: { name: 'sk', type: dynamodb.AttributeType.STRING },
    }),
    busName: bus.busName,
    pollerRoleName: bus.pollerRoleName,
    configKey: new kms.Key(stack, 'ConfigKey'),
  });
  return { poller, stack, template: Template.fromStack(stack) };
}

describe('poller function (C2, spec §6.1)', () => {
  it('is a non-VPC zip Lambda with reserved concurrency 1 and timeout 2× the cadence', () => {
    const { template } = synth();
    template.hasResourceProperties('AWS::Lambda::Function', {
      Description: Match.stringLikeRegexp('tier-1 poller'),
      ReservedConcurrentExecutions: 1,
      Timeout: 120,
      // Non-VPC is load-bearing (NAT would dominate stack cost): no VpcConfig.
      VpcConfig: Match.absent(),
      Environment: {
        Variables: Match.objectLike({
          DEPLOYMENT_NAME: 'ci',
          EVENT_BUS_NAME: 'ci-bus',
          POLL_CADENCE_SECONDS: '60',
          POLLER_CONCURRENCY: '8',
        }),
      },
    });
  });

  it('creates its role under the name the bus resource policy binds to', () => {
    const { template } = synth();
    template.hasResourceProperties('AWS::IAM::Role', {
      RoleName: 'ci-poller',
      AssumeRolePolicyDocument: Match.objectLike({
        Statement: [
          Match.objectLike({ Principal: { Service: 'lambda.amazonaws.com' } }),
        ],
      }),
    });
  });

  it('scopes the poller role per the §10.3 inventory', () => {
    const { template } = synth();
    // Config-plane reads: deploy keys + repo configs + host-key pins + the
    // GitHub App credentials for tier-2 token minting (spec §13.1).
    template.hasResourceProperties('AWS::IAM::Policy', {
      PolicyDocument: Match.objectLike({
        Statement: Match.arrayWith([
          Match.objectLike({
            Sid: 'ConfigPlaneReads',
            Action: ['ssm:GetParameter', 'ssm:GetParameters', 'ssm:GetParametersByPath'],
            Resource: Match.arrayWith([
              Match.objectLike({
                'Fn::Join': Match.arrayWith([
                  Match.arrayWith([Match.stringLikeRegexp('parameter/millwright/ci/repos')]),
                ]),
              }),
              Match.objectLike({
                'Fn::Join': Match.arrayWith([
                  Match.arrayWith([
                    Match.stringLikeRegexp('parameter/millwright/ci/github/app'),
                  ]),
                ]),
              }),
            ]),
          }),
          // PutEvents is usable ONLY as millwright.poller.
          Match.objectLike({
            Sid: 'EmitAsPollerOnly',
            Action: 'events:PutEvents',
            Condition: { StringEquals: { 'events:source': 'millwright.poller' } },
          }),
        ]),
      }),
    });
    // Polling-table read/write rides the standard table grant.
    template.hasResourceProperties('AWS::IAM::Policy', {
      PolicyDocument: Match.objectLike({
        Statement: Match.arrayWith([
          Match.objectLike({
            Action: Match.arrayWith(['dynamodb:GetItem', 'dynamodb:PutItem']),
          }),
        ]),
      }),
    });
  });

  it('clamps the timeout at Lambda\'s 15-minute ceiling for very slow cadences', () => {
    const { template } = synth(Duration.minutes(10));
    template.hasResourceProperties('AWS::Lambda::Function', {
      Description: Match.stringLikeRegexp('tier-1 poller'),
      Timeout: 900,
    });
  });

  it('grants registry reads for the cron pass, conditioned to the REG# prefix', () => {
    const { template } = synth();
    template.hasResourceProperties('AWS::Lambda::Function', {
      Environment: {
        Variables: Match.objectLike({
          STATE_TABLE_NAME: Match.anyValue(),
        }),
      },
    });
    template.hasResourceProperties('AWS::IAM::Policy', {
      PolicyDocument: Match.objectLike({
        Statement: Match.arrayWith([
          Match.objectLike({
            Sid: 'RegistryReadsForCron',
            Action: 'dynamodb:GetItem',
            Condition: {
              'ForAllValues:StringLike': { 'dynamodb:LeadingKeys': ['REG#*'] },
            },
          }),
        ]),
      }),
    });
  });

  it('warns that cron granularity degrades when the cadence exceeds one minute', () => {
    const oneMinute = synth();
    Annotations.fromStack(oneMinute.stack).hasNoWarning(
      '/Test/Poller',
      Match.stringLikeRegexp('cron granularity'),
    );
    const fiveMinutes = synth(Duration.minutes(5));
    Annotations.fromStack(fiveMinutes.stack).hasWarning(
      '/Test/Poller',
      Match.stringLikeRegexp('cron granularity degrades to the cadence.*'),
    );
  });
});

describe('poll tick schedule (spec §6.1)', () => {
  it('fires at the cadence with a one-minute jitter window and no retries', () => {
    const { template } = synth();
    template.hasResourceProperties('AWS::Scheduler::Schedule', {
      ScheduleExpression: 'rate(1 minute)',
      FlexibleTimeWindow: { Mode: 'FLEXIBLE', MaximumWindowInMinutes: 1 },
      Target: Match.objectLike({ RetryPolicy: { MaximumRetryAttempts: 0 } }),
    });
  });

  it('pluralizes slower cadences and rejects sub-minute ones', () => {
    const { template } = synth(Duration.minutes(5));
    template.hasResourceProperties('AWS::Scheduler::Schedule', {
      ScheduleExpression: 'rate(5 minutes)',
    });
    expect(() => synth(Duration.seconds(30))).toThrow('whole number of minutes');
  });
});

describe('poller alarms (spec §6.1, §6.3)', () => {
  it('alarms on sustained tick overlap via the throttles metric', () => {
    const { template } = synth();
    template.hasResourceProperties('AWS::CloudWatch::Alarm', {
      AlarmName: 'ci-poller-overlap',
      MetricName: 'Throttles',
      Namespace: 'AWS/Lambda',
      EvaluationPeriods: 3,
    });
  });

  it('alarms on the open circuit breaker and on auto-reconciled host-key rotation', () => {
    const { template } = synth();
    template.hasResourceProperties('AWS::CloudWatch::Alarm', {
      AlarmName: 'ci-poller-circuit-breaker',
      MetricName: 'CircuitBreakerOpen',
      Namespace: 'Millwright/Poller',
      Dimensions: [{ Name: 'Deployment', Value: 'ci' }],
    });
    template.hasResourceProperties('AWS::CloudWatch::Alarm', {
      AlarmName: 'ci-poller-host-key-rotation',
      MetricName: 'HostKeyRotationReconciled',
      Namespace: 'Millwright/Poller',
    });
  });
});
