import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { EventBridgeClient } from '@aws-sdk/client-eventbridge';
import { SFNClient } from '@aws-sdk/client-sfn';
import { SSMClient } from '@aws-sdk/client-ssm';
import { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import { Command } from 'commander';
import { DEPLOYMENT_ENV_VAR, Deployment, DiscoveryError, discoverDeployment } from './discovery';
import { init } from './init';
import {
  RunsCommandError,
  cancelRun,
  manifestResource,
  rerunRun,
  resolveRunRef,
} from './runs';
import { VERSION } from './version';

export function buildProgram(): Command {
  const program = new Command('millwright');
  program
    .description('Operate a millwright deployment — polling-driven CI/CD in your own AWS account')
    .version(VERSION)
    .option(
      '--deployment <name>',
      `deployment to operate on (defaults to $${DEPLOYMENT_ENV_VAR}, or auto-discovery ` +
        'when the account+region has exactly one)',
    );

  program
    .command('init')
    .description('scaffold the minimal two-file CDK app that deploys millwright')
    .argument('[directory]', 'target directory', '.')
    .option('--deployment-name <name>', 'deployment name namespacing SSM and resources', 'millwright')
    .option('--permissions-boundary <arn>', 'managed policy ARN used as the permissions boundary')
    .action((directory: string, options: { deploymentName: string; permissionsBoundary?: string }) => {
      const result = init({
        directory,
        deploymentName: options.deploymentName,
        permissionsBoundary: options.permissionsBoundary,
      });
      process.stdout.write(`Scaffolded ${result.files.join(', ')} in ${result.directory}\n`);
      if (!options.permissionsBoundary) {
        process.stdout.write(
          'Note: app.ts uses Boundary.NONE — replace it with your permissions boundary ARN ' +
            'before deploying to anything you care about.\n',
        );
      }
      process.stdout.write('Next: npm install && npx cdk deploy, then millwright doctor.\n');
    });

  const runs = program.command('runs').description('operate on cloud runs');

  runs
    .command('cancel')
    .description(
      'request cancellation: the decider stops in-flight builds and lands every job terminal',
    )
    .argument('<run>', 'workflow#number (with --repo) or owner/name#workflow#number')
    .option('--repo <owner/name>', 'repo scoping a workflow#number reference')
    .action(async (runRef: string, options: { repo?: string }) => {
      const deployment = await discover(program);
      const coords = resolveRunRef(runRef, options.repo);
      const result = await cancelRun(
        {
          dynamo: documentClient(),
          sfn: new SFNClient({}),
          tableName: manifestResource(deployment, 'stateTable'),
        },
        coords,
      );
      if (!result.requested) {
        process.stdout.write(`Run ${result.runId} already finished ${result.status}.\n`);
        return;
      }
      process.stdout.write(
        `Cancellation requested for ${result.runId}` +
          (result.woke ? ' (decider woken).\n' : ' (the decider picks it up within a minute).\n'),
      );
    });

  runs
    .command('rerun')
    .description('create a new run from the stored job model — no re-synth')
    .argument('<run>', 'workflow#number (with --repo) or owner/name#workflow#number')
    .option('--repo <owner/name>', 'repo scoping a workflow#number reference')
    .option('--failed', 'rerun failed jobs and their skipped dependents, reusing succeeded outputs')
    .action(async (runRef: string, options: { repo?: string; failed?: boolean }) => {
      const deployment = await discover(program);
      const coords = resolveRunRef(runRef, options.repo);
      const result = await rerunRun(
        {
          dynamo: documentClient(),
          events: new EventBridgeClient({}),
          tableName: manifestResource(deployment, 'stateTable'),
          busName: manifestResource(deployment, 'eventBus'),
        },
        coords,
        { failed: options.failed === true },
      );
      process.stdout.write(
        `Rerun requested for ${result.sourceRunId}` +
          (result.failedOnly ? ' (failed jobs only; succeeded outputs reused).' : '.') +
          ' Watch it with: millwright runs list\n',
      );
    });

  program
    .command('doctor')
    .description('verify the deployment chain (v0: SSM manifest discovery)')
    .action(async () => {
      const deployment = await discover(program);
      process.stdout.write(
        `OK: deployment "${deployment.name}" (${deployment.manifestParameterName})\n` +
          `    control plane v${deployment.manifest.version}, ` +
          `run-model schema <= ${deployment.manifest.schemaVersion}\n` +
          'Further checks (App credentials, deploy keys, poller health) land with those components.\n',
      );
    });

  return program;
}

function discover(program: Command): Promise<Deployment> {
  return discoverDeployment(new SSMClient({}), { explicitName: program.opts().deployment });
}

function documentClient(): DynamoDBDocumentClient {
  return DynamoDBDocumentClient.from(new DynamoDBClient({}), {
    marshallOptions: { removeUndefinedValues: true },
  });
}

export async function main(argv: readonly string[]): Promise<number> {
  const program = buildProgram();
  try {
    await program.parseAsync(argv as string[]);
    return 0;
  } catch (err) {
    if (err instanceof DiscoveryError || err instanceof RunsCommandError) {
      process.stderr.write(`millwright: ${err.message}\n`);
      return 1;
    }
    throw err;
  }
}
