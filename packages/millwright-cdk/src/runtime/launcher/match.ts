import { RegistryItem, ValidBusEvent, shortRefName } from '@copperbox/millwright-state';

/**
 * Step 3 of the pinned launcher order: match an event against a per-ref
 * registry entry (spec §8.3). Registry rows are read back from DynamoDB and
 * were written from a synthed model, but the launcher still narrows them
 * defensively — a workflow whose entry cannot be interpreted is SKIPPED and
 * reported, never run without its declared gating (fail closed).
 */

export interface MatchedWorkflow {
  readonly workflow: string;
  readonly concurrency?: {
    readonly group: string;
    readonly policy: 'queue' | 'supersede';
  };
}

export interface MatchResult {
  readonly matched: readonly MatchedWorkflow[];
  /** Workflow names whose registry entries could not be interpreted. */
  readonly malformed: readonly string[];
}

/**
 * The §12a glob dialect, shared with `secretsAllowedRefs`: patterns match the
 * short ref name, anchored at both ends; `*` is the only metacharacter and
 * crosses `/`; `main` matches exactly `main`, never `mainline`.
 */
export function matchesRefPattern(shortRef: string, pattern: string): boolean {
  if (shortRef.startsWith('refs/')) {
    return false;
  }
  const escape = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`^${pattern.split('*').map(escape).join('.*')}$`).test(shortRef);
}

interface NarrowedTrigger {
  readonly kind: string;
  readonly branches?: readonly string[];
  readonly pattern?: string;
}

function narrowTriggers(value: unknown): NarrowedTrigger[] | undefined {
  if (!Array.isArray(value)) {
    return undefined;
  }
  const triggers: NarrowedTrigger[] = [];
  for (const entry of value) {
    if (typeof entry !== 'object' || entry === null) {
      return undefined;
    }
    const kind = (entry as { kind?: unknown }).kind;
    if (typeof kind !== 'string') {
      return undefined;
    }
    const branches = (entry as { branches?: unknown }).branches;
    if (
      branches !== undefined &&
      (!Array.isArray(branches) || branches.some((b) => typeof b !== 'string'))
    ) {
      return undefined;
    }
    const pattern = (entry as { pattern?: unknown }).pattern;
    if (pattern !== undefined && typeof pattern !== 'string') {
      return undefined;
    }
    triggers.push({ kind, branches: branches as readonly string[] | undefined, pattern });
  }
  return triggers;
}

function narrowConcurrency(value: unknown): MatchedWorkflow['concurrency'] | null | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (typeof value !== 'object' || value === null) {
    return null;
  }
  const group = (value as { group?: unknown }).group;
  const policy = (value as { policy?: unknown }).policy;
  if (typeof group !== 'string' || !group || (policy !== 'queue' && policy !== 'supersede')) {
    return null;
  }
  return { group, policy };
}

function triggerMatches(trigger: NarrowedTrigger, event: ValidBusEvent): boolean {
  switch (event.kind) {
    // A new branch's head and a push to an existing branch both mean "this
    // branch now points at this commit" — both satisfy push triggers.
    case 'push':
    case 'branch':
      return (
        trigger.kind === 'push' &&
        (trigger.branches === undefined ||
          trigger.branches.some((b) => matchesRefPattern(shortRefName(event.ref), b)))
      );
    case 'tag':
      return (
        trigger.kind === 'tag' &&
        typeof trigger.pattern === 'string' &&
        matchesRefPattern(shortRefName(event.ref), trigger.pattern)
      );
    case 'pr':
      return trigger.kind === 'pull_request';
    // The poller already evaluated the cron expression against this minute;
    // the launcher re-checks only that the workflow still declares a cron.
    case 'cron':
      return trigger.kind === 'cron';
    case 'dispatch':
      return trigger.kind === 'manual';
    // bootstrap events route to the synth-only path before matching, and
    // rerun events re-execute one named run without any trigger matching.
    case 'bootstrap':
    case 'rerun':
      return false;
  }
}

export function matchWorkflows(registry: RegistryItem, event: ValidBusEvent): MatchResult {
  const matched: MatchedWorkflow[] = [];
  const malformed: string[] = [];
  const workflows =
    typeof registry.workflows === 'object' && registry.workflows !== null
      ? registry.workflows
      : {};
  for (const name of Object.keys(workflows).sort()) {
    // cron and dispatch events target one named workflow.
    if ((event.kind === 'cron' || event.kind === 'dispatch') && event.workflow !== name) {
      continue;
    }
    const entry = workflows[name];
    const triggers = narrowTriggers((entry as { triggers?: unknown })?.triggers);
    const concurrency = narrowConcurrency((entry as { concurrency?: unknown })?.concurrency);
    if (triggers === undefined || concurrency === null) {
      malformed.push(name);
      continue;
    }
    if (triggers.some((trigger) => triggerMatches(trigger, event))) {
      matched.push(concurrency ? { workflow: name, concurrency } : { workflow: name });
    }
  }
  return { matched, malformed };
}

/**
 * One workflow's narrowed concurrency entry, for paths that bypass trigger
 * matching (rerun): `undefined` = none declared (or no such workflow),
 * `null` = declared but uninterpretable — callers must fail closed on null
 * exactly like {@link matchWorkflows} does.
 */
export function workflowConcurrency(
  registry: RegistryItem,
  workflow: string,
): MatchedWorkflow['concurrency'] | null | undefined {
  const workflows =
    typeof registry.workflows === 'object' && registry.workflows !== null
      ? registry.workflows
      : {};
  const entry = workflows[workflow];
  if (entry === undefined) {
    return undefined;
  }
  return narrowConcurrency((entry as { concurrency?: unknown }).concurrency);
}

/**
 * Expand a concurrency group key's trigger-context tokens (spec §8.2):
 * `${repo}`, `${ref}` (short ref name), `${workflow}`, `${event}` (kind).
 */
export function evaluateGroupKey(template: string, event: ValidBusEvent, workflow: string): string {
  return template
    .replaceAll('${repo}', event.repo)
    .replaceAll('${ref}', shortRefName(event.ref))
    .replaceAll('${workflow}', workflow)
    .replaceAll('${event}', event.kind);
}
