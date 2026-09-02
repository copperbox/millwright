import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { EventBridgeClient, PutEventsCommand } from '@aws-sdk/client-eventbridge';
import { SSMClient } from '@aws-sdk/client-ssm';
import { DynamoDBDocumentClient, GetCommand } from '@aws-sdk/lib-dynamodb';
import {
  BRANCH_REF_PREFIX,
  BusEventDetail,
  CLI_EVENT_SOURCE,
  DispatchInputValue,
  RegistryItem,
  registryKey,
  validateBusEvent,
} from '@copperbox/millwright-state';
import { SsmClientLike, discoverDeployment } from './discovery';

/**
 * `millwright dispatch <wf>` — always cloud (spec §6.4, §7.1): puts a
 * `dispatch` event on the bus under the operator's own AWS credentials. The
 * bus resource policy conditions CLI principals to `source: millwright.cli`,
 * and the launcher accepts `dispatch` only from that source — the uniform
 * launcher path, no special lane.
 *
 * A dispatch always carries a ref (default: the default-branch head),
 * resolved to a sha via `git ls-remote` against the checkout's `origin`
 * remote so definition and source are both pinned at that ref. Inputs are
 * typed (choices/booleans) against the workflow's `Trigger.manual`
 * declaration in the registry.
 */

export class DispatchError extends Error {}

/** Runs `git <args>` and resolves with stdout; rejects on a non-zero exit. */
export type GitRunner = (args: readonly string[]) => Promise<string>;

export interface DispatchDeps {
  readonly ssm: SsmClientLike;
  readonly runGit: GitRunner;
  readonly getRegistryEntry: (
    tableName: string,
    repo: string,
    ref: string,
  ) => Promise<RegistryItem | undefined>;
  readonly putEvent: (busName: string, detail: BusEventDetail) => Promise<void>;
  readonly stdout: (line: string) => void;
}

export interface DispatchOptions {
  readonly workflow: string;
  /** Branch, tag or full ref name; default: the default-branch head. */
  readonly ref?: string;
  /** Repeated `k=v` pairs from `--input`. */
  readonly inputs?: readonly string[];
  /** Explicit deployment selection (`--deployment` / MILLWRIGHT_DEPLOYMENT). */
  readonly deployment?: string;
  /** Repo override; default: parsed from the checkout's `origin` remote. */
  readonly repo?: string;
}

const REPO_PATTERN = /^[^\s#/]+\/[^\s#/]+$/;

/** `owner/name` from the usual GitHub remote forms, or undefined. */
export function repoFromRemoteUrl(url: string): string | undefined {
  const match =
    /^git@github\.com:(.+)$/.exec(url) ??
    /^(?:ssh|https):\/\/(?:[^@/]+@)?github\.com\/(.+)$/.exec(url);
  if (!match) {
    return undefined;
  }
  const repo = match[1].replace(/\.git$/, '').replace(/\/$/, '');
  return REPO_PATTERN.test(repo) ? repo : undefined;
}

/** Repeated `--input k=v` arguments as a raw string map. */
export function parseInputArgs(args: readonly string[]): Record<string, string> {
  const inputs: Record<string, string> = {};
  for (const arg of args) {
    const separator = arg.indexOf('=');
    if (separator < 1) {
      throw new DispatchError(`--input expects k=v, got "${arg}"`);
    }
    const name = arg.slice(0, separator);
    if (name in inputs) {
      throw new DispatchError(`--input "${name}" given more than once`);
    }
    inputs[name] = arg.slice(separator + 1);
  }
  return inputs;
}

interface ResolvedRef {
  readonly ref: string;
  readonly sha: string;
  readonly defaultBranch?: string;
}

/**
 * One `ls-remote --symref` round-trip resolves everything: the HEAD symref
 * names the default branch, and the candidate patterns (exact full ref, or
 * `refs/heads/` then `refs/tags/` for a short name) pin the target sha.
 */
async function resolveRef(runGit: GitRunner, refOption: string | undefined): Promise<ResolvedRef> {
  let candidates: string[] = [];
  if (refOption !== undefined) {
    candidates = refOption.startsWith('refs/')
      ? [refOption]
      : [`${BRANCH_REF_PREFIX}${refOption}`, `refs/tags/${refOption}`];
  }
  const output = await runGit(['ls-remote', '--symref', 'origin', 'HEAD', ...candidates]);

  let defaultBranch: string | undefined;
  const shas = new Map<string, string>();
  for (const line of output.split('\n')) {
    const symref = /^ref:\s+(\S+)\s+HEAD$/.exec(line);
    if (symref) {
      defaultBranch = symref[1].startsWith(BRANCH_REF_PREFIX)
        ? symref[1].slice(BRANCH_REF_PREFIX.length)
        : undefined;
      continue;
    }
    const entry = /^([0-9a-f]{40,64})\s+(\S+)$/i.exec(line);
    if (entry) {
      shas.set(entry[2], entry[1].toLowerCase());
    }
  }

  if (refOption === undefined) {
    const headSha = shas.get('HEAD');
    if (!defaultBranch || !headSha) {
      throw new DispatchError(
        'could not resolve the default-branch head from origin (empty repository?); ' +
          'pass --ref explicitly',
      );
    }
    return { ref: `${BRANCH_REF_PREFIX}${defaultBranch}`, sha: headSha, defaultBranch };
  }
  for (const candidate of candidates) {
    const sha = shas.get(candidate);
    if (sha) {
      return { ref: candidate, sha, defaultBranch };
    }
  }
  throw new DispatchError(
    `ref "${refOption}" not found on origin (tried ${candidates.join(', ')})`,
  );
}

type DeclaredInput =
  | { readonly kind: 'choices'; readonly choices: readonly string[]; readonly default?: string }
  | { readonly kind: 'boolean'; readonly default?: boolean };

/**
 * The workflow's `Trigger.manual` input declarations from its registry entry,
 * narrowed defensively — anything uninterpretable fails the dispatch instead
 * of passing untyped values through.
 */
function manualInputDeclarations(
  registry: RegistryItem,
  workflow: string,
  registryRef: string,
): Record<string, DeclaredInput> {
  const workflows =
    typeof registry.workflows === 'object' && registry.workflows !== null ? registry.workflows : {};
  const entry = workflows[workflow] as { triggers?: unknown } | undefined;
  if (!entry) {
    const known = Object.keys(workflows).sort().join(', ') || '(none)';
    throw new DispatchError(
      `workflow "${workflow}" is not registered at ${registryRef} — known workflows: ${known}`,
    );
  }
  const triggers = Array.isArray(entry.triggers) ? entry.triggers : [];
  const manual = triggers.find(
    (t): t is { kind: string; inputs?: unknown } =>
      typeof t === 'object' && t !== null && (t as { kind?: unknown }).kind === 'manual',
  );
  if (!manual) {
    throw new DispatchError(
      `workflow "${workflow}" does not declare Trigger.manual at ${registryRef} — ` +
        'a dispatch event would match nothing',
    );
  }
  if (manual.inputs === undefined) {
    return {};
  }
  if (typeof manual.inputs !== 'object' || manual.inputs === null || Array.isArray(manual.inputs)) {
    throw new DispatchError(`workflow "${workflow}" has an uninterpretable manual-input map`);
  }
  const declared: Record<string, DeclaredInput> = {};
  for (const [name, decl] of Object.entries(manual.inputs)) {
    const choices = (decl as { choices?: unknown })?.choices;
    if (Array.isArray(choices) && choices.every((c) => typeof c === 'string')) {
      const fallback = (decl as { default?: unknown }).default;
      declared[name] = {
        kind: 'choices',
        choices,
        ...(typeof fallback === 'string' ? { default: fallback } : {}),
      };
      continue;
    }
    if ((decl as { type?: unknown })?.type === 'boolean') {
      const fallback = (decl as { default?: unknown }).default;
      declared[name] = {
        kind: 'boolean',
        ...(typeof fallback === 'boolean' ? { default: fallback } : {}),
      };
      continue;
    }
    throw new DispatchError(
      `workflow "${workflow}" input "${name}" has an uninterpretable declaration`,
    );
  }
  return declared;
}

/** Validate and coerce raw `k=v` inputs against the declaration; apply defaults, fail on missing required choices. */
function typeInputs(
  raw: Record<string, string>,
  declared: Record<string, DeclaredInput>,
  workflow: string,
): Record<string, DispatchInputValue> {
  const typed: Record<string, DispatchInputValue> = {};
  for (const [name, value] of Object.entries(raw)) {
    const declaration = declared[name];
    if (!declaration) {
      const known = Object.keys(declared).sort().join(', ') || '(none)';
      throw new DispatchError(
        `workflow "${workflow}" does not declare an input "${name}" — declared inputs: ${known}`,
      );
    }
    if (declaration.kind === 'boolean') {
      if (value !== 'true' && value !== 'false') {
        throw new DispatchError(`input "${name}" is a boolean: pass true or false, got "${value}"`);
      }
      typed[name] = value === 'true';
    } else {
      if (!declaration.choices.includes(value)) {
        throw new DispatchError(
          `input "${name}" must be one of ${declaration.choices.join(', ')}, got "${value}"`,
        );
      }
      typed[name] = value;
    }
  }
  for (const [name, declaration] of Object.entries(declared)) {
    if (name in typed) {
      continue;
    }
    if (declaration.default !== undefined) {
      typed[name] = declaration.default;
    } else if (declaration.kind === 'choices') {
      // Booleans fall back to `false` in synth; a defaultless choice input has
      // nothing to fall back to and synth would reject it as `missing-input`.
      // Fail here instead, worded as `millwright run` words the same gap.
      throw new DispatchError(
        `input "${name}" has no default — pass --input ${name}=<${declaration.choices.join('|')}>`,
      );
    }
  }
  return typed;
}

export async function dispatch(options: DispatchOptions, deps: DispatchDeps): Promise<void> {
  const { workflow } = options;
  if (!workflow || workflow.includes('#') || /\s/.test(workflow)) {
    throw new DispatchError(`"${workflow}" is not a valid workflow name`);
  }
  const rawInputs = parseInputArgs(options.inputs ?? []);

  let repo = options.repo;
  if (repo === undefined) {
    const remoteUrl = (await deps.runGit(['remote', 'get-url', 'origin'])).trim();
    repo = repoFromRemoteUrl(remoteUrl);
    if (!repo) {
      throw new DispatchError(
        `could not infer a GitHub repo from the origin remote ("${remoteUrl}") — ` +
          'run from a checkout of the watched repo or pass --repo <owner/name>',
      );
    }
  } else if (!REPO_PATTERN.test(repo)) {
    throw new DispatchError(`--repo must be "owner/name", got "${repo}"`);
  }

  const resolved = await resolveRef(deps.runGit, options.ref);
  const deployment = await discoverDeployment(deps.ssm, { explicitName: options.deployment });
  const resources = deployment.manifest.resources as
    | { eventBus?: unknown; stateTable?: unknown }
    | undefined;
  const busName = resources?.eventBus;
  const stateTable = resources?.stateTable;
  if (typeof busName !== 'string' || typeof stateTable !== 'string') {
    throw new DispatchError(
      `deployment "${deployment.name}" has a manifest without event-bus/state-table resources — ` +
        'redeploy with a newer @copperbox/millwright-cdk',
    );
  }

  // Registry entry for the ref, falling back to the default branch's — the
  // same lookup order the launcher uses (spec §8.3).
  let registry = await deps.getRegistryEntry(stateTable, repo, resolved.ref);
  const defaultRef = resolved.defaultBranch
    ? `${BRANCH_REF_PREFIX}${resolved.defaultBranch}`
    : undefined;
  if (!registry && defaultRef && defaultRef !== resolved.ref) {
    registry = await deps.getRegistryEntry(stateTable, repo, defaultRef);
  }

  let inputs: Record<string, DispatchInputValue> | undefined;
  if (registry) {
    inputs = typeInputs(
      rawInputs,
      manualInputDeclarations(registry, workflow, registry.ref),
      workflow,
    );
  } else if (Object.keys(rawInputs).length > 0) {
    throw new DispatchError(
      `no registry entry for ${repo}@${resolved.ref} (or its default branch) — ` +
        'typed inputs cannot be validated; push the workflow definition first',
    );
  } else {
    deps.stdout(
      `note: no registry entry for ${repo}@${resolved.ref} yet — the launcher will run a ` +
        'bootstrap synth before this dispatch starts',
    );
  }

  const detail: BusEventDetail = {
    repo,
    ref: resolved.ref,
    sha: resolved.sha,
    kind: 'dispatch',
    ...(resolved.defaultBranch ? { defaultBranch: resolved.defaultBranch } : {}),
    workflow,
    ...(inputs && Object.keys(inputs).length > 0 ? { inputs } : {}),
  };
  // The same static validation the launcher applies — catches a malformed
  // event here instead of as a silent launcher rejection.
  const validation = validateBusEvent(CLI_EVENT_SOURCE, 'dispatch', detail);
  if (!validation.ok) {
    throw new DispatchError(`refusing to emit an invalid dispatch event: ${validation.reason}`);
  }

  await deps.putEvent(busName, detail);
  deps.stdout(
    `Dispatched ${workflow} on ${repo} at ${resolved.ref}@${resolved.sha.slice(0, 7)}` +
      (detail.inputs ? ` with inputs ${JSON.stringify(detail.inputs)}` : ''),
  );
}

const execFileAsync = promisify(execFile);

/** Production wiring: real git, SSM discovery, DynamoDB registry reads, PutEvents. */
export function createDispatchDeps(): DispatchDeps {
  const dynamo = DynamoDBDocumentClient.from(new DynamoDBClient({}), {
    marshallOptions: { removeUndefinedValues: true },
  });
  const eventBridge = new EventBridgeClient({});
  return {
    ssm: new SSMClient({}),
    runGit: async (args) => {
      try {
        const { stdout } = await execFileAsync('git', args as string[], {
          encoding: 'utf8',
          maxBuffer: 10 * 1024 * 1024,
        });
        return stdout;
      } catch (err) {
        const stderr = (err as { stderr?: string }).stderr?.trim();
        throw new DispatchError(`git ${args[0]} failed${stderr ? `: ${stderr}` : ''}`);
      }
    },
    getRegistryEntry: async (tableName, repo, ref) => {
      const result = await dynamo.send(
        new GetCommand({ TableName: tableName, Key: registryKey(repo, ref) }),
      );
      return result.Item as RegistryItem | undefined;
    },
    putEvent: async (busName, detail) => {
      const result = await eventBridge.send(
        new PutEventsCommand({
          Entries: [
            {
              EventBusName: busName,
              Source: CLI_EVENT_SOURCE,
              DetailType: 'dispatch',
              Detail: JSON.stringify(detail),
            },
          ],
        }),
      );
      if ((result.FailedEntryCount ?? 0) > 0) {
        const failure = result.Entries?.find((entry) => entry.ErrorCode);
        throw new DispatchError(
          `PutEvents rejected the dispatch event` +
            (failure ? ` (${failure.ErrorCode}: ${failure.ErrorMessage})` : ''),
        );
      }
    },
    stdout: (line) => process.stdout.write(`${line}\n`),
  };
}
