/**
 * Run identity for the observability commands (spec §15): runs are named
 * `ci#142` — workflow-scoped numbers — with `owner/repo/ci#142` as the
 * qualified form when two watched repos share a workflow name. Everywhere a
 * run argument is optional, the latest run is the default.
 */

import { RunCoordinates, RunItem } from '@copperbox/millwright-state';
import { configPlaneRoot, repoFromConfigParameterName } from '@copperbox/millwright-state';
import { CommandError, listParametersByPrefix } from './config-plane';
import { Deployment, SsmClientLike } from './discovery';
import { DynamoDocClientLike, listRegistryEntries, getRun, queryNewestRuns } from './state-reads';

/** A parsed run argument; absent parts fall back to latest-run defaults. */
export interface RunRef {
  readonly repo?: string;
  readonly workflow?: string;
  readonly runNumber?: number;
}

/** One workflow known to the deployment. */
export interface WorkflowCoordinates {
  readonly repo: string;
  readonly workflow: string;
}

export function formatRunId(run: RunCoordinates): string {
  return `${run.workflow}#${run.runNumber}`;
}

export function formatQualifiedRunId(run: RunCoordinates): string {
  return `${run.repo}/${run.workflow}#${run.runNumber}`;
}

/**
 * Parse `ci#142`, `ci`, `owner/repo/ci#142` or `owner/repo/ci`. A bare
 * `owner/repo` cannot be told apart from a workflow named with one slash, so
 * one-slash names are rejected with the qualified form spelled out.
 */
export function parseRunRef(text: string): RunRef {
  const hash = text.indexOf('#');
  const name = hash === -1 ? text : text.slice(0, hash);
  let runNumber: number | undefined;
  if (hash !== -1) {
    const digits = text.slice(hash + 1);
    if (!/^\d+$/.test(digits) || Number(digits) < 1) {
      throw new CommandError(
        `"${text}" is not a run id — expected <workflow>#<number>, like ci#142`,
      );
    }
    runNumber = Number(digits);
  }
  if (!name) {
    throw new CommandError(`"${text}" is not a run id — expected <workflow>#<number>, like ci#142`);
  }
  const segments = name.split('/');
  if (segments.some((segment) => !segment)) {
    throw new CommandError(`"${text}" is not a run id — empty path segment`);
  }
  if (segments.length === 1) {
    return { workflow: name, runNumber };
  }
  if (segments.length >= 3) {
    return {
      repo: `${segments[0]}/${segments[1]}`,
      workflow: segments.slice(2).join('/'),
      runNumber,
    };
  }
  throw new CommandError(
    `"${text}" is ambiguous — name a workflow (ci#142) or qualify it as owner/repo/workflow#142`,
  );
}

export interface StateReadContext {
  readonly ssm: SsmClientLike;
  readonly ddb: DynamoDocClientLike;
  readonly deployment: Deployment;
  readonly stateTable: string;
}

/**
 * Workflows known to the deployment: watched repos from the config plane,
 * each repo's workflow names from its registry entries. The registry is
 * TTL-exempt and refreshed by every successful synth (§8.3), so it is the
 * durable index of what can run.
 */
export async function discoverWorkflows(context: StateReadContext): Promise<WorkflowCoordinates[]> {
  const prefix = `${configPlaneRoot(context.deployment.name)}/repos/`;
  const repos: string[] = [];
  for (const parameter of await listParametersByPrefix(context.ssm, prefix)) {
    const repo = repoFromConfigParameterName(context.deployment.name, parameter.name);
    if (repo && parameter.name.endsWith('/config')) {
      repos.push(repo);
    }
  }
  const found: WorkflowCoordinates[] = [];
  for (const repo of repos.sort()) {
    const names = new Set<string>();
    for (const entry of await listRegistryEntries(context.ddb, context.stateTable, repo)) {
      for (const workflow of Object.keys(entry.workflows ?? {})) {
        names.add(workflow);
      }
    }
    for (const workflow of [...names].sort()) {
      found.push({ repo, workflow });
    }
  }
  return found;
}

/** Resolve a workflow name (optionally repo-qualified) to one repo's workflow. */
export async function resolveWorkflow(
  context: StateReadContext,
  ref: RunRef,
): Promise<WorkflowCoordinates> {
  const workflows = await discoverWorkflows(context);
  const matches = workflows.filter(
    (candidate) =>
      candidate.workflow === ref.workflow && (ref.repo === undefined || candidate.repo === ref.repo),
  );
  if (matches.length === 1) {
    return matches[0];
  }
  if (matches.length === 0) {
    const known = workflows.map((w) => `${w.repo}/${w.workflow}`).join(', ') || '(none registered)';
    throw new CommandError(
      `no workflow "${ref.repo ? `${ref.repo}/` : ''}${ref.workflow}" is registered — known: ${known}`,
    );
  }
  throw new CommandError(
    `workflow "${ref.workflow}" exists in more than one repo — qualify the run id: ` +
      matches.map((w) => `${w.repo}/${w.workflow}${ref.runNumber ? `#${ref.runNumber}` : ''}`).join(', '),
  );
}

/**
 * Resolve an optional run argument to a run item. No argument → the most
 * recently created run across every workflow; a bare workflow → its latest
 * run; `wf#n` → exactly that run.
 */
export async function resolveRun(
  context: StateReadContext,
  runArg: string | undefined,
): Promise<RunItem> {
  if (runArg === undefined) {
    const workflows = await discoverWorkflows(context);
    let latest: RunItem | undefined;
    for (const { repo, workflow } of workflows) {
      const [run] = await queryNewestRuns(context.ddb, context.stateTable, repo, workflow, 1);
      if (run && (!latest || run.createdAt > latest.createdAt)) {
        latest = run;
      }
    }
    if (!latest) {
      throw new CommandError(
        `deployment "${context.deployment.name}" has no runs yet — push to a watched repo ` +
          'or use "millwright dispatch"',
      );
    }
    return latest;
  }

  const ref = parseRunRef(runArg);
  const { repo, workflow } = await resolveWorkflow(context, ref);
  if (ref.runNumber === undefined) {
    const [run] = await queryNewestRuns(context.ddb, context.stateTable, repo, workflow, 1);
    if (!run) {
      throw new CommandError(`workflow ${repo}/${workflow} has no runs yet`);
    }
    return run;
  }
  const run = await getRun(context.ddb, context.stateTable, {
    repo,
    workflow,
    runNumber: ref.runNumber,
  });
  if (!run) {
    throw new CommandError(`no run ${formatRunId({ repo, workflow, runNumber: ref.runNumber })} in ${repo}`);
  }
  return run;
}
