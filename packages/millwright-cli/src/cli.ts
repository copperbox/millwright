import { CloudWatchLogsClient } from '@aws-sdk/client-cloudwatch-logs';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { ECRClient } from '@aws-sdk/client-ecr';
import { EventBridgeClient } from '@aws-sdk/client-eventbridge';
import { IAMClient } from '@aws-sdk/client-iam';
import { SFNClient } from '@aws-sdk/client-sfn';
import { ServiceQuotasClient } from '@aws-sdk/client-service-quotas';
import { SSMClient } from '@aws-sdk/client-ssm';
import { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import * as os from 'node:os';
import {
  GithubCredentialsFormatError,
  KeyFormatError,
  RepoConfigFormatError,
  RunModelError,
} from '@copperbox/millwright-state';
import { Command } from 'commander';
import { CommandError, requireManifestResource } from './config-plane';
import { DefinitionLoadError } from './definition-loader';
import { DEPLOYMENT_ENV_VAR, Deployment, DiscoveryError, discoverDeployment } from './discovery';
import { DispatchError, createDispatchDeps, dispatch } from './dispatch';
import { DoctorDeps, doctor } from './doctor';
import { GitProtocolError } from './git/ls-refs';
import { HostKeyMismatchError } from './git/ssh';
import { GithubApiError } from './github/rest';
import { init } from './init';
import { DockerExecutor, createDockerProcessRunner } from './local/executor';
import { isLocalRunId } from './local/local-layout';
import { DEFAULT_DEFINITION_ENTRY, LocalRunDeps, localRun } from './local/local-run';
import { resolveShimDir } from './local/shim-delivery';
import { createGitRunner } from './local/source-archive';
import { LogsDeps, logs } from './logs';
import { promptLine, promptSecret, waitForOperator } from './prompts';
import { RepoDeps, repoAdd, repoList, repoRemove, repoUpdate } from './repo';
import {
  RunsCommandError,
  RunsDeps,
  cancelRun,
  rerunRun,
  resolveRunRef,
  runsList,
  runsShow,
  runsShowLocal,
} from './runs';
import { secretsSet } from './secrets';
import { SetupDeps, refreshHostKeys, setup } from './setup';
import { DEFAULT_ENTRY, runSynthCommand } from './synth-command';
import { VERSION } from './version';

function output(line: string): void {
  process.stdout.write(`${line}\n`);
}

function docClient(): DynamoDBDocumentClient {
  return DynamoDBDocumentClient.from(new DynamoDBClient({}), {
    marshallOptions: { removeUndefinedValues: true },
  });
}

function awsRegion(): string | undefined {
  return process.env.AWS_REGION ?? process.env.AWS_DEFAULT_REGION;
}

function runsDeps(): RunsDeps {
  return { ssm: new SSMClient({}), ddb: docClient(), output, region: awsRegion() };
}

function logsDeps(): LogsDeps {
  return { ssm: new SSMClient({}), ddb: docClient(), cwl: new CloudWatchLogsClient({}), output };
}

function doctorDeps(): DoctorDeps {
  return {
    ssm: new SSMClient({}),
    ddb: docClient(),
    iam: new IAMClient({}),
    quotas: new ServiceQuotasClient({}),
    ecr: new ECRClient({}),
    fetchLike: fetch,
    output,
  };
}

function setupDeps(): SetupDeps {
  return {
    ssm: new SSMClient({}),
    fetchLike: fetch,
    output,
    promptSecret,
  };
}

function localRunDeps(): LocalRunDeps {
  return {
    output,
    git: createGitRunner(),
    executor: new DockerExecutor({
      run: createDockerProcessRunner(),
      onLog: (job, line) => output(`[${job}] ${line}`),
      warn: (message) => process.stderr.write(`${message}\n`),
    }),
    shimDir: resolveShimDir(process.env),
    cwd: process.cwd(),
    promptLine: process.stdin.isTTY ? promptLine : undefined,
    onCancel: (handler) => {
      let fired = false;
      const listener = () => {
        if (fired) {
          // Second Ctrl-C: the operator wants out now.
          process.exit(130);
        }
        fired = true;
        handler();
      };
      process.on('SIGINT', listener);
      return () => process.removeListener('SIGINT', listener);
    },
    defaultParallel: Math.max(1, os.availableParallelism?.() ?? os.cpus().length),
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

/**
 * A per-invocation holder for the exit code a command action wants to report.
 * The synth and run actions signal failure by writing here rather than by
 * throwing, and `main` reads it back once `parseAsync` resolves. Keeping the
 * signal off `process.exitCode` means bin.ts is the only writer of process
 * state and a failing `main()` leaves nothing behind for the next call.
 */
interface ExitSignal {
  code: number;
}

function buildProgramWithSignal(): { program: Command; exitCode: () => number } {
  const signal: ExitSignal = { code: 0 };
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
          signal.code = code;
        }
      },
    );

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
    .description(
      'verify the chain: manifest, App creds (incl. per-repo pulls probe), deploy keys, ' +
        'poller health, registry priming, quotas, ECR policies, rulesets',
    )
    .action(async () => {
      const report = await doctor(doctorDeps(), { explicitName: program.opts().deployment });
      if (report.failed > 0) {
        throw new CommandError(
          `${report.failed} check${report.failed === 1 ? '' : 's'} failed — see the [FAIL] lines above`,
        );
      }
    });

  program
    .command('run')
    .description('run a workflow locally in docker — always local; cloud runs use "dispatch"')
    .argument('<workflow>', 'workflow name from the definition')
    .option('--job <name>', "run one job, its consumes fed from prior local runs' artifacts")
    .option('--with-deps', 'with --job: run the ancestor subgraph instead of reusing')
    .option('--clean', 'run from "git archive HEAD" instead of the working tree')
    .option('--platform <p>', 'docker --platform, for exact-arch parity with the cloud')
    .option('--secrets-file <path>', 'env file with declared secret values (default .millwright/secrets.env)')
    .option(
      '--input <k=v>',
      'typed input for a Trigger.manual workflow (repeatable; prompted when omitted)',
      (value: string, previous: string[]) => [...previous, value],
      [] as string[],
    )
    .option('--as-tag <tag>', 'fake a tag ref for the run context (e.g. v9.9.9-test)')
    .option('--parallel <n>', 'max concurrent jobs (default: CPU count)', (value) =>
      Number.parseInt(value, 10),
    )
    .option('--entry <path>', 'definition entry point', DEFAULT_DEFINITION_ENTRY)
    .action(
      async (
        workflow: string,
        options: {
          job?: string;
          withDeps?: boolean;
          clean?: boolean;
          platform?: string;
          secretsFile?: string;
          input: string[];
          asTag?: string;
          parallel?: number;
          entry?: string;
        },
      ) => {
        const result = await localRun(localRunDeps(), { workflow, ...options });
        if (result.status !== 'SUCCEEDED') {
          signal.code = 1;
        }
      },
    );

  program
    .command('dispatch')
    .description(
      'start a cloud run of a workflow — always at a ref (default: the default-branch head), ' +
        'resolved to a sha so definition and source are pinned together',
    )
    .argument('<workflow>', 'workflow name as declared in workflows.ts')
    .option('--ref <ref>', 'branch, tag or full ref to run at')
    .option(
      '--input <k=v>',
      'typed workflow input (repeatable); validated against Trigger.manual',
      (value: string, previous: string[]) => [...previous, value],
      [] as string[],
    )
    .option('--repo <owner/name>', 'repo override when not run from a checkout of it')
    .action(async (workflow: string, options: { ref?: string; input: string[]; repo?: string }) => {
      await dispatch(
        {
          workflow,
          ref: options.ref,
          inputs: options.input,
          repo: options.repo,
          deployment: program.opts().deployment,
        },
        createDispatchDeps(),
      );
    });

  const runs = program.command('runs').description('operate on and inspect cloud runs');

  runs
    .command('list')
    .description('list recent runs, newest first')
    .option('--workflow <wf>', 'only this workflow (name or owner/repo/name)')
    .option('--ref <ref>', 'only runs of this ref (short or full form)')
    .option('--status <s>', 'only runs with this status (e.g. RUNNING, FAILED)')
    .option('--limit <n>', 'rows to show', (value) => Number.parseInt(value, 10), 20)
    .action(async (options: { workflow?: string; ref?: string; status?: string; limit: number }) => {
      await runsList(runsDeps(), { ...options, explicitName: program.opts().deployment });
    });

  runs
    .command('show')
    .description('show one run — jobs, steps, checks; defaults to the latest run; local-N reads this clone')
    .argument('[run]', 'run id like ci#142, owner/repo/ci#142, or local-3; omit for the latest')
    .action(async (run: string | undefined) => {
      if (run && isLocalRunId(run)) {
        runsShowLocal({ output }, run);
        return;
      }
      await runsShow(runsDeps(), { run, explicitName: program.opts().deployment });
    });

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
          dynamo: docClient(),
          sfn: new SFNClient({}),
          tableName: requireManifestResource(deployment, 'stateTable', 'state table'),
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
          dynamo: docClient(),
          events: new EventBridgeClient({}),
          tableName: requireManifestResource(deployment, 'stateTable', 'state table'),
          busName: requireManifestResource(deployment, 'eventBus', 'event bus'),
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
    .command('logs')
    .description("print or tail a run's job logs from CloudWatch")
    .argument('[run]', 'run id like ci#142; omit for the latest run')
    .option('-f, --follow', 'tail via polled GetLogEvents (~2 s cadence)')
    .option('--job <name>', 'only this job')
    .option('--failed', 'only failed jobs')
    .option('--full', 'dump each stream from the beginning')
    .action(
      async (
        run: string | undefined,
        options: { follow?: boolean; job?: string; failed?: boolean; full?: boolean },
      ) => {
        await logs(logsDeps(), { run, ...options, explicitName: program.opts().deployment });
      },
    );

  program
    .command('refresh-host-keys')
    .description("re-pin GitHub's SSH host keys from /meta (manual hatch for rotations)")
    .action(async () => {
      await refreshHostKeys(
        { ssm: new SSMClient({}), fetchLike: fetch, output },
        { explicitName: program.opts().deployment },
      );
    });

  const secrets = program.command('secrets').description('manage workflow secrets');

  secrets
    .command('set')
    .description('write one workflow secret (value prompted, never echoed)')
    .argument('<name>', 'secret name, surfaced to jobs as an environment variable')
    .option('--scope <scope>', 'secret scope; defaults to the repo of the cwd origin remote')
    .action(async (name: string, options: { scope?: string }) => {
      await secretsSet(
        { ssm: new SSMClient({}), output, promptSecret },
        { name, scope: options.scope, explicitName: program.opts().deployment },
      );
    });

  return { program, exitCode: () => signal.code };
}

export function buildProgram(): Command {
  return buildProgramWithSignal().program;
}

function discover(program: Command): Promise<Deployment> {
  return discoverDeployment(new SSMClient({}), { explicitName: program.opts().deployment });
}

const USER_FACING_ERRORS = [
  DiscoveryError,
  RunsCommandError,
  CommandError,
  GithubApiError,
  HostKeyMismatchError,
  GitProtocolError,
  RepoConfigFormatError,
  GithubCredentialsFormatError,
  KeyFormatError,
  RunModelError,
  DefinitionLoadError,
  DispatchError,
];

export async function main(argv: readonly string[]): Promise<number> {
  const { program, exitCode } = buildProgramWithSignal();
  try {
    await program.parseAsync(argv as string[]);
    return exitCode();
  } catch (err) {
    if (USER_FACING_ERRORS.some((kind) => err instanceof kind)) {
      process.stderr.write(`millwright: ${(err as Error).message}\n`);
      return 1;
    }
    throw err;
  }
}
