import { App, Stack } from 'aws-cdk-lib';
import { Match, Template } from 'aws-cdk-lib/assertions';
import * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
import * as kms from 'aws-cdk-lib/aws-kms';
import { describe, expect, it } from 'vitest';
import { Reporter } from '../src';
import { checkStateKey } from '@copperbox/millwright-state';
import { coordinatesFromStreamRecords } from '../src/runtime/reporter/handler';

function synth(): { reporter: Reporter; template: Template } {
  const stack = new Stack(new App(), 'Test');
  const reporter = new Reporter(stack, 'Reporter', {
    deploymentName: 'ci',
    stateTable: new dynamodb.Table(stack, 'StateTable', {
      partitionKey: { name: 'pk', type: dynamodb.AttributeType.STRING },
      sortKey: { name: 'sk', type: dynamodb.AttributeType.STRING },
      stream: dynamodb.StreamViewType.NEW_AND_OLD_IMAGES,
    }),
    configKey: new kms.Key(stack, 'ConfigKey'),
  });
  return { reporter, template: Template.fromStack(stack) };
}

describe('reporter wiring (C8)', () => {
  it('consumes the state-table stream filtered to CHECK# keys', () => {
    const { template } = synth();
    template.hasResourceProperties('AWS::Lambda::EventSourceMapping', {
      StartingPosition: 'LATEST',
      BatchSize: 100,
      MaximumRetryAttempts: 3,
      FilterCriteria: {
        Filters: [
          {
            Pattern: JSON.stringify({
              dynamodb: { Keys: { pk: { S: [{ prefix: 'CHECK#' }] } } },
            }),
          },
        ],
      },
    });
  });

  it('sweeps unconverged items every minute via a distinguishing payload', () => {
    const { template } = synth();
    template.hasResourceProperties('AWS::Events::Rule', {
      ScheduleExpression: 'rate(1 minute)',
      Targets: [Match.objectLike({ Input: '{"sweep":true}' })],
    });
  });

  it('points the function at the state table and the credentials parameter', () => {
    const { reporter, template } = synth();
    expect(reporter.credentialsParameterName).toBe('/millwright/ci/github/app');
    template.hasResourceProperties('AWS::Lambda::Function', {
      Environment: {
        Variables: Match.objectLike({
          GITHUB_CREDENTIALS_PARAMETER: '/millwright/ci/github/app',
          STATE_TABLE_NAME: Match.anyValue(),
        }),
      },
    });
  });

  it('grants table read/write, stream read, parameter read and CMK decrypt', () => {
    const { template } = synth();
    const policies = template.findResources('AWS::IAM::Policy');
    const statements = JSON.stringify(
      Object.values(policies).flatMap(
        (policy) => policy.Properties.PolicyDocument.Statement as unknown[],
      ),
    );
    expect(statements).toContain('dynamodb:UpdateItem');
    expect(statements).toContain('dynamodb:GetRecords');
    expect(statements).toContain('ssm:GetParameter');
    expect(statements).toContain(':parameter/millwright/ci/github/app');
    expect(statements).toContain('kms:Decrypt');
  });
});

describe('coordinatesFromStreamRecords', () => {
  const SHA = 'a'.repeat(40);
  const key = checkStateKey('octocat/app', SHA, 'ci / build');
  const record = (pk: string, sk: string, eventName = 'MODIFY') => ({
    eventName,
    dynamodb: { Keys: { pk: { S: pk }, sk: { S: sk } } },
  });

  it('coalesces several writes to one item into one reconcile', () => {
    const coords = coordinatesFromStreamRecords([
      record(key.pk, key.sk, 'INSERT'),
      record(key.pk, key.sk),
      record(key.pk, key.sk),
    ]);
    expect(coords).toEqual([{ repo: 'octocat/app', sha: SHA, context: 'ci / build' }]);
  });

  it('skips REMOVE events and non-check keys', () => {
    const coords = coordinatesFromStreamRecords([
      record(key.pk, key.sk, 'REMOVE'),
      record('WF#octocat/app#ci', 'COUNTER'),
      record(key.pk, 'CTX#ci / test'),
    ]);
    expect(coords).toEqual([{ repo: 'octocat/app', sha: SHA, context: 'ci / test' }]);
  });
});
