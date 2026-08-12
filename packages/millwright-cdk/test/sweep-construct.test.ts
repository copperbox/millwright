import { App, Duration, Stack } from 'aws-cdk-lib';
import { Match, Template } from 'aws-cdk-lib/assertions';
import * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
import { describe, expect, it } from 'vitest';
import { Sweep } from '../src';

const RUN_EXECUTOR_ARN = 'arn:aws:states:eu-west-1:123456789012:stateMachine:ci-run-executor';

function synth(deploymentName = 'ci'): Template {
  const stack = new Stack(new App(), 'Test');
  const table = new dynamodb.Table(stack, 'StateTable', {
    partitionKey: { name: 'pk', type: dynamodb.AttributeType.STRING },
    sortKey: { name: 'sk', type: dynamodb.AttributeType.STRING },
  });
  new Sweep(stack, 'Sweep', {
    deploymentName,
    stateTable: table,
    runExecutorArn: RUN_EXECUTOR_ARN,
    metadataRetention: Duration.days(90),
  });
  return Template.fromStack(stack);
}

describe('sweep construct (C16)', () => {
  it('ticks on the 1-minute scheduler', () => {
    const template = synth();
    template.hasResourceProperties('AWS::Events::Rule', {
      ScheduleExpression: 'rate(1 minute)',
      Targets: Match.arrayWith([Match.objectLike({ Arn: Match.anyValue() })]),
    });
  });

  it('finishes under the cadence with its table and hand-off environment', () => {
    const template = synth();
    template.hasResourceProperties('AWS::Lambda::Function', {
      Description: Match.stringLikeRegexp('sweep'),
      Timeout: 55,
      Environment: {
        Variables: {
          STATE_TABLE_NAME: Match.anyValue(),
          RUN_EXECUTOR_ARN,
          METADATA_RETENTION_DAYS: '90',
        },
      },
    });
  });

  it('holds table access and StartExecution on the run executor — the decider-equivalent hand-off', () => {
    const template = synth();
    template.hasResourceProperties('AWS::IAM::Policy', {
      PolicyDocument: {
        Statement: Match.arrayWith([
          Match.objectLike({
            Action: 'states:StartExecution',
            Resource: RUN_EXECUTOR_ARN,
          }),
        ]),
      },
    });
    const statements = Object.values(template.findResources('AWS::IAM::Policy')).flatMap(
      (resource: any) => resource.Properties.PolicyDocument.Statement,
    );
    const dynamoActions = statements
      .flatMap((s: any) => (Array.isArray(s.Action) ? s.Action : [s.Action]))
      .filter((action: string) => action.startsWith('dynamodb:'));
    expect(dynamoActions).toContain('dynamodb:UpdateItem');
    expect(dynamoActions).toContain('dynamodb:Scan');
  });
});
