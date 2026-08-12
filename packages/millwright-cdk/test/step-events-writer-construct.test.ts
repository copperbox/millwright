import { App, Duration, Stack } from 'aws-cdk-lib';
import { Match, Template } from 'aws-cdk-lib/assertions';
import * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
import { describe, expect, it } from 'vitest';
import { MillwrightEventBus, StepEventsWriter } from '../src';

function synth(deploymentName = 'ci'): Template {
  const stack = new Stack(new App(), 'Test');
  const bus = new MillwrightEventBus(stack, 'EventBus', { deploymentName });
  const table = new dynamodb.Table(stack, 'StateTable', {
    partitionKey: { name: 'pk', type: dynamodb.AttributeType.STRING },
    sortKey: { name: 'sk', type: dynamodb.AttributeType.STRING },
  });
  new StepEventsWriter(stack, 'StepEventsWriter', {
    deploymentName,
    bus: bus.bus,
    stateTable: table,
    metadataRetention: Duration.days(90),
  });
  return Template.fromStack(stack);
}

function policiesOf(template: Template, scope: string): unknown[] {
  return Object.entries(template.findResources('AWS::IAM::Policy'))
    .filter(([id]) => id.includes(scope))
    .map(([, resource]) => resource);
}

describe('step-events writer construct (C19)', () => {
  it('rules on millwright.step from the deployment bus, and only on the source', () => {
    const template = synth();
    template.hasResourceProperties('AWS::Events::Rule', {
      EventPattern: { source: ['millwright.step'] },
      EventBusName: Match.anyValue(),
    });
    const [rule] = Object.values(template.findResources('AWS::Events::Rule'));
    expect(rule.Properties.EventPattern).toEqual({ source: ['millwright.step'] });
  });

  it('targets the writer Lambda with its table and retention environment', () => {
    const template = synth();
    template.hasResourceProperties('AWS::Lambda::Function', {
      Environment: {
        Variables: {
          STATE_TABLE_NAME: Match.anyValue(),
          METADATA_RETENTION_DAYS: '90',
        },
      },
    });
  });

  it('grants step-row writes only: UpdateItem, no reads, no streams', () => {
    const template = synth();
    const statements = policiesOf(template, 'StepEventsWriter').flatMap(
      (resource: any) => resource.Properties.PolicyDocument.Statement,
    );
    const dynamoActions = statements
      .flatMap((s: any) => (Array.isArray(s.Action) ? s.Action : [s.Action]))
      .filter((action: string) => action.startsWith('dynamodb:'));
    expect(dynamoActions).toEqual(['dynamodb:UpdateItem']);
  });
});
