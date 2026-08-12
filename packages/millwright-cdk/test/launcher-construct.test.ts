import { App, Duration, Stack } from 'aws-cdk-lib';
import { Match, Template } from 'aws-cdk-lib/assertions';
import * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
import * as s3 from 'aws-cdk-lib/aws-s3';
import { describe, expect, it } from 'vitest';
import { Launcher, MillwrightEventBus } from '../src';

function synth(): { launcher: Launcher; template: Template } {
  const stack = new Stack(new App(), 'Test');
  const bus = new MillwrightEventBus(stack, 'EventBus', { deploymentName: 'ci' });
  const launcher = new Launcher(stack, 'Launcher', {
    deploymentName: 'ci',
    bus: bus.bus,
    stateTable: new dynamodb.Table(stack, 'StateTable', {
      partitionKey: { name: 'pk', type: dynamodb.AttributeType.STRING },
      sortKey: { name: 'sk', type: dynamodb.AttributeType.STRING },
    }),
    artifactBucket: new s3.Bucket(stack, 'Artifacts'),
    metadataRetention: Duration.days(90),
  });
  return { launcher, template: Template.fromStack(stack) };
}

describe('launcher wiring (C4)', () => {
  it('routes trigger events (not step events) through the queue to the function', () => {
    const { template } = synth();
    template.hasResourceProperties('AWS::Events::Rule', {
      EventPattern: {
        source: ['millwright.poller', 'millwright.cli'],
        'detail-type': ['push', 'branch', 'tag', 'pr', 'cron', 'dispatch', 'bootstrap'],
      },
      Targets: [Match.objectLike({ Arn: Match.anyValue() })],
    });
    template.hasResourceProperties('AWS::SQS::Queue', {
      QueueName: 'ci-launcher',
      MessageRetentionPeriod: 24 * 60 * 60,
    });
    template.hasResourceProperties('AWS::Lambda::EventSourceMapping', {
      BatchSize: 10,
      FunctionResponseTypes: ['ReportBatchItemFailures'],
    });
  });

  it('pins the run executor name and pre-wires the grant and environment', () => {
    const { launcher, template } = synth();
    expect(launcher.runExecutorName).toBe('ci-run-executor');
    template.hasResourceProperties('AWS::Lambda::Function', {
      Environment: {
        Variables: Match.objectLike({
          RUN_EXECUTOR_ARN: Match.objectLike({
            'Fn::Join': Match.arrayWith([
              Match.arrayWith([Match.stringLikeRegexp(':stateMachine:ci-run-executor')]),
            ]),
          }),
          METADATA_RETENTION_DAYS: '90',
        }),
      },
    });
    template.hasResourceProperties('AWS::IAM::Policy', {
      PolicyDocument: {
        Statement: Match.arrayWith([
          Match.objectLike({
            Action: 'states:StartExecution',
            Effect: 'Allow',
          }),
        ]),
      },
    });
  });

  it('grants state-table read/write and runs/* object access', () => {
    const { template } = synth();
    const policies = template.findResources('AWS::IAM::Policy');
    const statements = Object.values(policies).flatMap(
      (policy) => policy.Properties.PolicyDocument.Statement as unknown[],
    );
    const actions = JSON.stringify(statements);
    expect(actions).toContain('dynamodb:PutItem');
    expect(actions).toContain('dynamodb:ConditionCheckItem');
    expect(actions).toContain('s3:GetObject');
    expect(actions).toContain('runs/*');
  });
});
