/**
 * `millwright secrets set <name> [--scope <scope>]` (spec §9.2, §15): write
 * one workflow secret to `/millwright/<name>/secrets/<scope>/<NAME>` as a
 * SecureString under the deployment CMK. The scope defaults to the repo —
 * inferred from the working directory's `origin` remote — matching how
 * `Secret` references resolve at dispatch (§4.2); secrets flow only to runs
 * on `secretsAllowedRefs`-matched refs (§12a).
 */

import { execFile } from 'node:child_process';
import { secretParameterName } from '@copperbox/millwright-state';
import { CommandError, configKeyId, putSecureStringParameter } from './config-plane';
import { DiscoverOptions, SsmClientLike, discoverDeployment } from './discovery';

export interface SecretsDeps {
  readonly ssm: SsmClientLike;
  readonly output: (line: string) => void;
  /** Reads the secret value without echoing. */
  readonly promptSecret: (question: string) => Promise<string>;
  /** Injectable for tests. @default the cwd's `origin` remote */
  readonly inferRepo?: () => Promise<string | undefined>;
}

export interface SecretsSetOptions extends DiscoverOptions {
  readonly name: string;
  readonly scope?: string;
}

/** `owner/repo` from an SSH, ssh://, git://, or https GitHub remote URL. */
export function parseGithubRemote(url: string): string | undefined {
  const match =
    url.match(/^git@github\.com:([^/]+\/[^/]+?)(?:\.git)?\/?$/) ??
    url.match(/^(?:ssh|git):\/\/(?:git@)?github\.com\/([^/]+\/[^/]+?)(?:\.git)?\/?$/) ??
    url.match(/^https?:\/\/github\.com\/([^/]+\/[^/]+?)(?:\.git)?\/?$/);
  return match?.[1];
}

async function originRepo(): Promise<string | undefined> {
  const url = await new Promise<string | undefined>((resolve) => {
    execFile('git', ['remote', 'get-url', 'origin'], (err, stdout) => {
      resolve(err ? undefined : stdout.trim());
    });
  });
  return url ? parseGithubRemote(url) : undefined;
}

/**
 * The parameter-name shape `secretParameterName` accepts: one SSM path
 * segment. The env var a secret lands in is named by the workflow's record
 * key, not by this parameter name, so kebab-case is fine here.
 */
const SECRET_NAME_PATTERN = /^[A-Za-z0-9_.-]+$/;

export async function secretsSet(deps: SecretsDeps, options: SecretsSetOptions): Promise<void> {
  if (!SECRET_NAME_PATTERN.test(options.name)) {
    throw new CommandError(
      `"${options.name}" is not a secret name — it becomes one segment of the secret's ` +
        'SSM parameter path, so it must match [A-Za-z0-9_.-]+ (no "/")',
    );
  }
  const deployment = await discoverDeployment(deps.ssm, options);
  const keyId = configKeyId(deployment);

  const scope = options.scope ?? (await (deps.inferRepo ?? originRepo)());
  if (!scope) {
    throw new CommandError(
      'no --scope given and the working directory has no GitHub "origin" remote to default ' +
        'to — pass --scope <owner/repo> (or a shared scope name)',
    );
  }

  const value = await deps.promptSecret(`Value for ${options.name} (input hidden): `);
  if (!value) {
    throw new CommandError('no value entered — nothing written');
  }

  const parameter = secretParameterName(deployment.name, scope, options.name);
  await putSecureStringParameter(
    deps.ssm,
    parameter,
    value,
    keyId,
    `millwright workflow secret ${options.name} (scope ${scope})`,
  );
  deps.output(`Wrote ${parameter} (scope ${scope}).`);
  deps.output(
    'Runs consume it via a Secret reference; it flows only to runs on refs matched by the ' +
      "repo's secretsAllowedRefs.",
  );
}
