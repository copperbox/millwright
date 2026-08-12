import { SSMClient } from '@aws-sdk/client-ssm';
import { Command } from 'commander';
import { DEPLOYMENT_ENV_VAR, DiscoveryError, discoverDeployment } from './discovery';
import { init } from './init';
import { DEFAULT_ENTRY, runSynthCommand } from './synth-command';
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
    .command('synth')
    .description('compile millwright/workflows.ts to the JSON run model')
    .option('--entry <path>', 'definition entry point', DEFAULT_ENTRY)
    .option('--repo <owner/name>', 'repo identity (default: derived from the git remote "origin")')
    .option('--commit <sha>', 'commit synthesized at (default: git HEAD)')
    .option('--ref <name>', 'short name of the triggering ref, e.g. main or release/1.2')
    .option('--out <file>', 'write the model to a file instead of stdout')
    .option(
      '--schema-ceiling <version>',
      "the control plane's supported run-model schemaVersion (cloud synth passes this)",
      (value: string) => Number.parseInt(value, 10),
    )
    .option(
      '--poll-cadence <minutes>',
      'deployment poll cadence, enables the cron granularity lint',
      (value: string) => Number.parseInt(value, 10),
    )
    .option(
      '--secrets-allowed-refs <patterns>',
      "comma-separated secretsAllowedRefs patterns (fail-fast lint only; enforcement is the decider's)",
      (value: string) => value.split(',').map((p) => p.trim()).filter((p) => p.length > 0),
    )
    .option('--pretty', 'pretty-print the JSON model')
    .action(
      (options: {
        entry: string;
        repo?: string;
        commit?: string;
        ref?: string;
        out?: string;
        schemaCeiling?: number;
        pollCadence?: number;
        secretsAllowedRefs?: string[];
        pretty?: boolean;
      }) => {
        const code = runSynthCommand(options);
        if (code !== 0) {
          process.exitCode = code;
        }
      },
    );

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
