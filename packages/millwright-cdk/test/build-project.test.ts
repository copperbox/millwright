import { App, Duration, Stack } from 'aws-cdk-lib';
import { Match, Template } from 'aws-cdk-lib/assertions';
import * as logs from 'aws-cdk-lib/aws-logs';
import * as s3 from 'aws-cdk-lib/aws-s3';
import { describe, expect, it } from 'vitest';
import { BuildProject } from '../src';

function synth(): { buildProject: BuildProject; template: Template } {
  const stack = new Stack(new App(), 'Test');
  const buildProject = new BuildProject(stack, 'BuildProject', {
    deploymentName: 'ci',
    artifactBucket: new s3.Bucket(stack, 'Artifacts'),
    buildLogGroup: new logs.LogGroup(stack, 'BuildLogs'),
  });
  return { buildProject, template: Template.fromStack(stack) };
}

describe('the single CodeBuild project (C11, spec §7.4)', () => {
  it('honors the run-executor-pinned name', () => {
    const { buildProject, template } = synth();
    expect(buildProject.projectName).toBe('ci-builds');
    template.hasResourceProperties('AWS::CodeBuild::Project', { Name: 'ci-builds' });
  });

  it('defaults to on-demand ARM small — x86 is a per-build override', () => {
    const { template } = synth();
    template.hasResourceProperties('AWS::CodeBuild::Project', {
      Environment: Match.objectLike({
        Type: 'ARM_CONTAINER',
        ComputeType: 'BUILD_GENERAL1_SMALL',
        PrivilegedMode: false,
      }),
    });
  });

  it('caps build duration at the 36 h ceiling and bounds the QUEUED phase', () => {
    const { template } = synth();
    template.hasResourceProperties('AWS::CodeBuild::Project', {
      TimeoutInMinutes: 36 * 60,
      QueuedTimeoutInMinutes: 8 * 60,
    });
  });

  it('delivers the shim prefix as the default S3 source', () => {
    const { template } = synth();
    template.hasResourceProperties('AWS::CodeBuild::Project', {
      Source: Match.objectLike({
        Type: 'S3',
        Location: Match.objectLike({
          'Fn::Join': Match.arrayWith([
            Match.arrayWith([Match.stringLikeRegexp('/control/shim/')]),
          ]),
        }),
      }),
      Artifacts: { Type: 'NO_ARTIFACTS' },
    });
  });

  it('writes build logs to the shared build log group (C17)', () => {
    const { template } = synth();
    template.hasResourceProperties('AWS::CodeBuild::Project', {
      LogsConfig: {
        CloudWatchLogs: Match.objectLike({ Status: 'ENABLED' }),
      },
    });
  });

  it('uses no CodeBuild-native cache — the keyed cache lives in the buildspec', () => {
    const { template } = synth();
    template.hasResourceProperties('AWS::CodeBuild::Project', {
      Cache: { Type: 'NO_CACHE' },
    });
  });
});
