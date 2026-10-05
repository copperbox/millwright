import { createHash } from 'node:crypto';

/**
 * Deterministic Step Functions execution names. The launcher starts every run
 * executor execution under a content-derived name so a redelivered event
 * cannot start the work twice; the CLI derives the same names to find those
 * executions again (doctor looks up a repo's bootstrap synth by name).
 *
 * Step Functions keeps a closed Standard execution's name reserved for 90
 * days, so a name that has already run to completion (or failure) cannot be
 * started again — see `synthExecutionName`.
 */

const NAME_LIMIT = 80;

/** `<prefix>-<readable>-<hash12(uniq)>`, confined to SFN's name charset. */
export function executionName(prefix: string, readable: string, uniq: string): string {
  const hash = createHash('sha256').update(uniq).digest('hex').slice(0, 12);
  const safe = readable.replace(/[^A-Za-z0-9_-]+/g, '-').replace(/^-+|-+$/g, '');
  const budget = NAME_LIMIT - prefix.length - hash.length - 2;
  return `${prefix}-${safe.slice(0, budget)}-${hash}`;
}

/**
 * The bootstrap (synth-only) execution for one (repo, ref, sha). A second
 * `bootstrap` event for the same commit, such as the one `repo add` emits
 * after a remove-and-re-add, resolves to this same name, so once the first
 * execution has closed no second synth of that commit can start.
 */
export function synthExecutionName(repo: string, ref: string, sha: string): string {
  return executionName('synth', `${repo}-${sha.slice(0, 12)}`, `${repo}#${ref}#${sha}`);
}

/**
 * `arn:…:execution:<machine>:<name>` for an execution of the state machine at
 * `stateMachineArn`; undefined when the ARN is not a state machine ARN.
 */
export function executionArn(stateMachineArn: string, name: string): string | undefined {
  const match = /^(arn:[^:]+:states:[^:]*:[^:]*):stateMachine:([^:]+)$/.exec(stateMachineArn);
  return match ? `${match[1]}:execution:${match[2]}:${name}` : undefined;
}
