import { App, Duration, Stack } from 'aws-cdk-lib';
import { Match, Template } from 'aws-cdk-lib/assertions';
import * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
import * as s3 from 'aws-cdk-lib/aws-s3';
import { describe, expect, it } from 'vitest';
import { RunExecutor } from '../src';

function synth(): { executor: RunExecutor; template: Template } {
  const stack = new Stack(new App(), 'Test');
  const executor = new RunExecutor(stack, 'RunExecutor', {
    deploymentName: 'ci',
    stateTable: new dynamodb.Table(stack, 'StateTable', {
      partitionKey: { name: 'pk', type: dynamodb.AttributeType.STRING },
      sortKey: { name: 'sk', type: dynamodb.AttributeType.STRING },
    }),
    artifactBucket: new s3.Bucket(stack, 'Artifacts'),
    eventBusName: 'ci-bus',
    metadataRetention: Duration.days(90),
  });
  return { executor, template: Template.fromStack(stack) };
}

describe('run executor wiring (C5–C7)', () => {
  it('honors the launcher-pinned machine name and pins the downstream contracts', () => {
    const { executor, template } = synth();
    expect(executor.stateMachineName).toBe('ci-run-executor');
    expect(executor.buildProjectName).toBe('ci-builds');
    expect(executor.synthFunctionName).toBe('ci-synth');
    expect(executor.postSynthFunctionName).toBe('ci-post-synth');
    template.hasResourceProperties('AWS::StepFunctions::StateMachine', {
      StateMachineName: 'ci-run-executor',
    });
  });

  it('embeds the decider loop and synth phase in the machine definition', () => {
    const { template } = synth();
    const machines = template.findResources('AWS::StepFunctions::StateMachine');
    const definition = Object.values(machines)[0].Properties.DefinitionString;
    // The definition references the decider through a Fn::Join over its ARN.
    const rendered = JSON.stringify(definition);
    expect(rendered).toContain('lambda:invoke.waitForTaskToken');
    expect(rendered).toContain('TimeoutSeconds\\":60');
    expect(rendered).toContain('states:startExecution');
    expect(rendered).not.toContain('HeartbeatSeconds');
  });

  it('gives the decider its table, model reads, CodeBuild dispatch and token sends', () => {
    const { template } = synth();
    template.hasResourceProperties('AWS::Lambda::Function', {
      Description: Match.stringLikeRegexp('decider'),
      Timeout: 90,
      Environment: {
        Variables: Match.objectLike({
          BUILD_PROJECT_NAME: 'ci-builds',
          DEPLOYMENT_NAME: 'ci',
          METADATA_RETENTION_DAYS: '90',
          // Group hand-off target (spec §8.4), spelled from the pinned name.
          RUN_EXECUTOR_ARN: Match.objectLike({
            'Fn::Join': Match.arrayWith([
              Match.arrayWith([Match.stringLikeRegexp(':stateMachine:ci-run-executor')]),
            ]),
          }),
        }),
      },
    });
    template.hasResourceProperties('AWS::IAM::Policy', {
      PolicyDocument: {
        Statement: Match.arrayWith([
          Match.objectLike({
            Action: ['codebuild:StartBuild', 'codebuild:StopBuild', 'codebuild:BatchGetBuilds'],
            Resource: Match.objectLike({
              'Fn::Join': Match.arrayWith([
                Match.arrayWith([Match.stringLikeRegexp(':project/ci-builds')]),
              ]),
            }),
          }),
          Match.objectLike({
            Action: ['states:SendTaskSuccess', 'states:SendTaskFailure'],
          }),
          // Concurrency-group hand-off: start the pending run on completion.
          Match.objectLike({
            Action: 'states:StartExecution',
            Resource: Match.objectLike({
              'Fn::Join': Match.arrayWith([
                Match.arrayWith([Match.stringLikeRegexp(':stateMachine:ci-run-executor')]),
              ]),
            }),
          }),
        ]),
      },
    });
  });

  it('lets the machine invoke the pinned synth Lambdas and start itself for carry-over', () => {
    const { template } = synth();
    template.hasResourceProperties('AWS::IAM::Policy', {
      PolicyDocument: {
        Statement: Match.arrayWith([
          Match.objectLike({
            Action: 'lambda:InvokeFunction',
            Resource: Match.arrayWith([
              Match.objectLike({
                'Fn::Join': Match.arrayWith([
                  Match.arrayWith([Match.stringLikeRegexp(':function:ci-synth')]),
                ]),
              }),
            ]),
          }),
          Match.objectLike({
            Action: 'states:StartExecution',
            Resource: Match.objectLike({
              'Fn::Join': Match.arrayWith([
                Match.arrayWith([Match.stringLikeRegexp(':stateMachine:ci-run-executor')]),
              ]),
            }),
          }),
        ]),
      },
    });
  });

  it('subscribes the build-events handler to this project on the DEFAULT bus', () => {
    const { template } = synth();
    template.hasResourceProperties('AWS::Events::Rule', {
      EventBusName: Match.absent(),
      EventPattern: {
        source: ['aws.codebuild'],
        'detail-type': ['CodeBuild Build State Change'],
        detail: { 'project-name': ['ci-builds'] },
      },
    });
    template.hasResourceProperties('AWS::Lambda::Function', {
      Description: Match.stringLikeRegexp('build events'),
      Environment: {
        Variables: Match.objectLike({ METADATA_RETENTION_DAYS: '90' }),
      },
    });
  });
});
