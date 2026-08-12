import { EventBridgeClient } from '@aws-sdk/client-eventbridge';
import { SSMClient } from '@aws-sdk/client-ssm';
import {
  GithubCredentialsFormatError,
  RepoConfigFormatError,
} from '@copperbox/millwright-state';
import { Command } from 'commander';
import { CommandError } from './config-plane';
import { DEPLOYMENT_ENV_VAR, DiscoveryError, discoverDeployment } from './discovery';
import { GitProtocolError } from './git/ls-refs';
import { HostKeyMismatchError } from './git/ssh';
import { GithubApiError } from './github/rest';
import { init } from './init';
import { promptSecret, waitForOperator } from './prompts';
import { RepoDeps, repoAdd, repoList, repoRemove, repoUpdate } from './repo';
import { SetupDeps, setup } from './setup';
import { VERSION } from './version';

function output(line: string): void {
  process.stdout.write(`${line}\n`);
}

function setupDeps(): SetupDeps {
  return {
    ssm: new SSMClient({}),
    fetchLike: fetch,
    output,
    promptSecret,
  };
}

function repoDeps(): RepoDeps {
  return {
    ssm: new SSMClient({}),
    eventBridge: new EventBridgeClient({}),
    fetchLike: fetch,
    output,
    waitForOperator,
  };
}

/** Split a comma-separated flag value, tolerating spaces after commas. */
function csv(value: string): string[] {
  return value
    .split(',')
    .map((entry) => entry.trim())
    .filter(Boolean);
}

function forkPrs(value: string): 'on' | 'off' {
  if (value !== 'on' && value !== 'off') {
    throw new CommandError(`--fork-prs must be "on" or "off", got "${value}"`);
  }
  return value;
}

function bool(flag: string, value: string): boolean {
  if (value === 'true' || value === 'on') {
    return true;
  }
  if (value === 'false' || value === 'off') {
    return false;
  }
  throw new CommandError(`${flag} must be true or false, got "${value}"`);
}

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
      process.stdout.write('Next: npm install && npx cdk deploy, then millwright setup.\n');
    });

  program
    .command('setup')
    .description('create the per-deployment GitHub App (manifest flow) and pin GitHub host keys')
    .option('--pat', 'fine-grained-PAT fallback: commit statuses instead of check runs')
    .option('--org <org>', 'create the GitHub App under this organization')
    .option('--app-name <name>', 'GitHub App name (names are globally unique)')
    .option('--force', 'replace existing GitHub credentials')
    .action(async (options: { pat?: boolean; org?: string; appName?: string; force?: boolean }) => {
      await setup(setupDeps(), { ...options, explicitName: program.opts().deployment });
    });

  const repo = program.command('repo').description('manage the repos this deployment watches');

  repo
    .command('add')
    .description('write repo config, mint+install its deploy key, and prime the registry')
    .argument('<owner/repo>', 'GitHub repository to watch')
    .option('--secrets-refs <refs>', 'comma-separated ref patterns whose runs receive secrets', csv)
    .option('--no-pr-polling', 'disable tier-2 PR polling for this repo')
    .option('--fork-prs <on|off>', 'run fork-authored PRs (default off)', forkPrs)
    .option('--ecr-repos <arns>', 'comma-separated private-ECR repository ARNs jobs may pull', csv)
    .action(
      async (
        repoName: string,
        options: {
          secretsRefs?: string[];
          prPolling: boolean;
          forkPrs?: 'on' | 'off';
          ecrRepos?: string[];
        },
      ) => {
        await repoAdd(repoDeps(), {
          repo: repoName,
          secretsRefs: options.secretsRefs,
          // Commander's --no-pr-polling flag defaults to true; leave the
          // config default alone unless the operator explicitly disabled it.
          prPolling: options.prPolling ? undefined : false,
          forkPrs: options.forkPrs,
          ecrRepos: options.ecrRepos,
          explicitName: program.opts().deployment,
        });
      },
    );

  repo
    .command('update')
    .description("change a watched repo's config; unspecified flags keep their values")
    .argument('<owner/repo>', 'GitHub repository')
    .option('--secrets-refs <refs>', 'comma-separated ref patterns whose runs receive secrets', csv)
    .option('--pr-polling <bool>', 'tier-2 PR polling toggle', (value) => bool('--pr-polling', value))
    .option('--fork-prs <on|off>', 'run fork-authored PRs', forkPrs)
    .option('--ecr-repos <arns>', 'comma-separated private-ECR repository ARNs jobs may pull', csv)
    .action(
      async (
        repoName: string,
        options: {
          secretsRefs?: string[];
          prPolling?: boolean;
          forkPrs?: 'on' | 'off';
          ecrRepos?: string[];
        },
      ) => {
        await repoUpdate(repoDeps(), {
          repo: repoName,
          ...options,
          explicitName: program.opts().deployment,
        });
      },
    );

  repo
    .command('list')
    .description('list watched repos and their config')
    .action(async () => {
      await repoList(repoDeps(), { explicitName: program.opts().deployment });
    });

  repo
    .command('remove')
    .description("delete a repo's config and deploy-key parameters")
    .argument('<owner/repo>', 'GitHub repository')
    .action(async (repoName: string) => {
      await repoRemove(repoDeps(), { repo: repoName, explicitName: program.opts().deployment });
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

const USER_FACING_ERRORS = [
  DiscoveryError,
  CommandError,
  GithubApiError,
  HostKeyMismatchError,
  GitProtocolError,
  RepoConfigFormatError,
  GithubCredentialsFormatError,
];

export async function main(argv: readonly string[]): Promise<number> {
  const program = buildProgram();
  try {
    await program.parseAsync(argv as string[]);
    return 0;
  } catch (err) {
    if (USER_FACING_ERRORS.some((kind) => err instanceof kind)) {
      process.stderr.write(`millwright: ${(err as Error).message}\n`);
      return 1;
    }
    throw err;
  }
}
