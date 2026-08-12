import { CodeBuildClient, StartBuildCommand } from '@aws-sdk/client-codebuild';
import { SynthPhaseConfig, SynthPhaseEvent, startSynthBuild } from './synth';

/**
 * Lambda host for the synth phase (`<deploymentName>-synth`, pinned name).
 * Invoked by the run executor with `waitForTaskToken`; a throw here is
 * caught by the machine's synth-phase Catch and fails the run visibly.
 */

const client = new CodeBuildClient({});

function required(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Missing required environment variable ${name}`);
  }
  return value;
}

function config(): SynthPhaseConfig {
  return {
    deploymentName: required('DEPLOYMENT_NAME'),
    projectName: required('BUILD_PROJECT_NAME'),
    synthRoleArn: required('SYNTH_JOB_ROLE_ARN'),
    artifactBucketName: required('ARTIFACT_BUCKET_NAME'),
    toolsBucketName: required('SYNTH_TOOLS_BUCKET'),
    toolsObjectKey: required('SYNTH_TOOLS_KEY'),
    schemaCeiling: Number(required('SCHEMA_CEILING')),
    pollCadenceMinutes: Number(required('POLL_CADENCE_MINUTES')),
  };
}

export async function handler(event: SynthPhaseEvent): Promise<{ buildId: string }> {
  const started = await startSynthBuild(
    {
      config: config(),
      start: async (input) => {
        const result = await client.send(
          new StartBuildCommand({
            ...input,
            environmentVariablesOverride: [...input.environmentVariablesOverride],
          }),
        );
        const buildId = result.build?.id;
        if (!buildId) {
          throw new Error('StartBuild for the synth job returned no build id');
        }
        return { buildId, ...(result.build?.arn ? { buildArn: result.build.arn } : {}) };
      },
    },
    event,
  );
  console.log(JSON.stringify({ message: 'synth build started', buildId: started.buildId }));
  return { buildId: started.buildId };
}
