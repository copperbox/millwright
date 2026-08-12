import { SSMClient } from '@aws-sdk/client-ssm';
import { Command } from 'commander';
import { DEPLOYMENT_ENV_VAR, DiscoveryError, discoverDeployment } from './discovery';
import { init } from './init';
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

  program
    .command('doctor')
    .description('verify the deployment chain (v0: SSM manifest discovery)')
    .action(async () => {
      const deployment = await discoverDeployment(new SSMClient({}), {
        explicitName: program.opts().deployment,
      });
      process.stdout.write(
        `OK: deployment "${deployment.name}" (${deployment.manifestParameterName})\n` +
          `    control plane v${deployment.manifest.version}, ` +
          `run-model schema <= ${deployment.manifest.schemaVersion}\n` +
          'Further checks (App credentials, deploy keys, poller health) land with those components.\n',
      );
    });

  return program;
}

export async function main(argv: readonly string[]): Promise<number> {
  const program = buildProgram();
  try {
    await program.parseAsync(argv as string[]);
    return 0;
  } catch (err) {
    if (err instanceof DiscoveryError) {
      process.stderr.write(`millwright: ${err.message}\n`);
      return 1;
    }
    throw err;
  }
}
