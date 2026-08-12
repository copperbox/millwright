import { TRIGGER_KINDS, TriggerKind } from './keys';

/**
 * The event-bus contract (spec C3, §7.1): sources, detail shapes, and the
 * launcher's static source/shape validation. Everything here is pure — the
 * launcher runs it before any I/O, so a rejected event can never poison the
 * dedupe item (council ruling B1 pins validation strictly before the dedupe
 * write).
 *
 * Emitters share these shapes: the poller emits `push`/`branch`/`tag`/`pr`/
 * `cron`, the CLI emits `dispatch`/`bootstrap` (`repo add` already emits
 * `{ repo, ref, sha, kind: 'bootstrap' }`). Event source is part of trigger
 * matching, not decoration — a forged push requires the poller role's own
 * credentials, enforced twice: by the bus resource policy and again here.
 */

export const POLLER_EVENT_SOURCE = 'millwright.poller';
export const CLI_EVENT_SOURCE = 'millwright.cli';
export const STEP_EVENT_SOURCE = 'millwright.step';

export const BUS_EVENT_SOURCES = [
  POLLER_EVENT_SOURCE,
  CLI_EVENT_SOURCE,
  STEP_EVENT_SOURCE,
] as const;
export type BusEventSource = (typeof BUS_EVENT_SOURCES)[number];

/**
 * The ONLY source each kind is accepted from. `push`/`branch`/`tag`/`pr`/
 * `cron` are poller observations; `dispatch`/`bootstrap` are operator
 * actions. No kind is ever legal from `millwright.step` — step events carry
 * their own detail types and are consumed by the step-events writer, never
 * the launcher.
 */
export const EVENT_KIND_SOURCE: Readonly<Record<TriggerKind, BusEventSource>> = {
  push: POLLER_EVENT_SOURCE,
  branch: POLLER_EVENT_SOURCE,
  tag: POLLER_EVENT_SOURCE,
  pr: POLLER_EVENT_SOURCE,
  cron: POLLER_EVENT_SOURCE,
  dispatch: CLI_EVENT_SOURCE,
  bootstrap: CLI_EVENT_SOURCE,
};

export const BRANCH_REF_PREFIX = 'refs/heads/';
export const TAG_REF_PREFIX = 'refs/tags/';
export const PR_REF_PREFIX = 'refs/pull/';

/** A typed input value on a `dispatch` event (`millwright dispatch`). */
export type DispatchInputValue = string | boolean;

/**
 * The EventBridge `detail` payload. `ref` is always a FULL ref name
 * (`refs/heads/main`, `refs/tags/v1.2`, `refs/pull/7/head`) — short names are
 * derived, never carried, so branch/tag namespaces can never collide in
 * registry or dedupe keys.
 */
export interface BusEventDetail {
  /** Watched repo as `owner/name`. */
  readonly repo: string;
  /** Full ref name the event is about (for `cron`: the default branch's ref). */
  readonly ref: string;
  /** Commit sha at that ref. */
  readonly sha: string;
  /** Mirrors the EventBridge detail-type; must agree when present. */
  readonly kind?: TriggerKind;
  /**
   * Short name of the repo's default branch, when the emitter knows it (the
   * poller always does — HEAD symref rides every ls-refs exchange). Enables
   * the launcher's default-branch registry fallback; absent means no
   * fallback, so a registry miss goes straight to bootstrap.
   */
  readonly defaultBranch?: string;
  /** Target workflow — required on `cron` and `dispatch` events. */
  readonly workflow?: string;
  /**
   * The UTC minute a cron fire is for (`YYYY-MM-DDTHH:mm`) — folded into the
   * dedupe identity so double-fires cancel exactly while distinct minutes on
   * an unchanged head still run.
   */
  readonly minute?: string;
  /** Typed inputs on a `dispatch` event. */
  readonly inputs?: Readonly<Record<string, DispatchInputValue>>;
}

/** A bus event that passed static source/shape validation. */
export interface ValidBusEvent {
  readonly source: BusEventSource;
  readonly kind: TriggerKind;
  readonly repo: string;
  readonly ref: string;
  readonly sha: string;
  readonly defaultBranch?: string;
  readonly workflow?: string;
  readonly minute?: string;
  readonly inputs?: Readonly<Record<string, DispatchInputValue>>;
}

export type BusEventValidation =
  | { readonly ok: true; readonly event: ValidBusEvent }
  | { readonly ok: false; readonly reason: string };

const REPO_PATTERN = /^[^\s#/]+\/[^\s#/]+$/;
const SHA_PATTERN = /^([0-9a-f]{40}|[0-9a-f]{64})$/i;
const MINUTE_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/;

const REF_PREFIX_BY_KIND: Readonly<Record<TriggerKind, string>> = {
  push: BRANCH_REF_PREFIX,
  branch: BRANCH_REF_PREFIX,
  tag: TAG_REF_PREFIX,
  pr: PR_REF_PREFIX,
  cron: BRANCH_REF_PREFIX,
  // dispatch may target any ref namespace the CLI resolved.
  dispatch: 'refs/',
  bootstrap: BRANCH_REF_PREFIX,
};

function reject(reason: string): BusEventValidation {
  return { ok: false, reason };
}

/**
 * Step 1 of the pinned launcher order: validate source and shape — static,
 * no I/O, no cross-check against the polling table's ref map (deleted by
 * council ruling B1). Returns a normalized event or a rejection reason.
 */
export function validateBusEvent(
  source: string,
  detailType: string,
  detail: unknown,
): BusEventValidation {
  if (!(TRIGGER_KINDS as readonly string[]).includes(detailType)) {
    return reject(`unknown detail-type "${detailType}"`);
  }
  const kind = detailType as TriggerKind;
  const requiredSource = EVENT_KIND_SOURCE[kind];
  if (source !== requiredSource) {
    return reject(`kind "${kind}" is only accepted from "${requiredSource}", got "${source}"`);
  }
  if (typeof detail !== 'object' || detail === null || Array.isArray(detail)) {
    return reject('detail must be a JSON object');
  }
  const d = detail as Record<string, unknown>;

  if (typeof d.repo !== 'string' || !REPO_PATTERN.test(d.repo) || d.repo.includes('..')) {
    return reject(`repo must be "owner/name", got ${JSON.stringify(d.repo)}`);
  }
  if (typeof d.sha !== 'string' || !SHA_PATTERN.test(d.sha)) {
    return reject('sha must be a full 40- or 64-char hex commit id');
  }
  const prefix = REF_PREFIX_BY_KIND[kind];
  if (
    typeof d.ref !== 'string' ||
    !d.ref.startsWith(prefix) ||
    d.ref.length <= prefix.length ||
    /\s/.test(d.ref)
  ) {
    return reject(`a "${kind}" event's ref must be a full ref under "${prefix}"`);
  }
  if (d.kind !== undefined && d.kind !== kind) {
    return reject(`detail.kind "${String(d.kind)}" contradicts detail-type "${kind}"`);
  }
  if (d.defaultBranch !== undefined) {
    if (
      typeof d.defaultBranch !== 'string' ||
      !d.defaultBranch ||
      /\s/.test(d.defaultBranch) ||
      d.defaultBranch.startsWith('refs/')
    ) {
      return reject('defaultBranch must be a short branch name');
    }
  }

  let workflow: string | undefined;
  if (kind === 'cron' || kind === 'dispatch') {
    if (typeof d.workflow !== 'string' || !d.workflow || d.workflow.includes('#')) {
      return reject(`a "${kind}" event must name its target workflow`);
    }
    workflow = d.workflow;
  }
  let minute: string | undefined;
  if (kind === 'cron') {
    if (typeof d.minute !== 'string' || !MINUTE_PATTERN.test(d.minute)) {
      return reject('a "cron" event must carry the fired minute as "YYYY-MM-DDTHH:mm" (UTC)');
    }
    minute = d.minute;
  }
  let inputs: Record<string, DispatchInputValue> | undefined;
  if (kind === 'dispatch' && d.inputs !== undefined) {
    if (typeof d.inputs !== 'object' || d.inputs === null || Array.isArray(d.inputs)) {
      return reject('dispatch inputs must be an object');
    }
    for (const [name, value] of Object.entries(d.inputs)) {
      if (typeof value !== 'string' && typeof value !== 'boolean') {
        return reject(`dispatch input "${name}" must be a string or boolean`);
      }
    }
    inputs = d.inputs as Record<string, DispatchInputValue>;
  }

  return {
    ok: true,
    event: {
      source: requiredSource,
      kind,
      repo: d.repo,
      ref: d.ref,
      sha: d.sha.toLowerCase(),
      defaultBranch: typeof d.defaultBranch === 'string' ? d.defaultBranch : undefined,
      workflow,
      minute,
      inputs,
    },
  };
}

/**
 * Short name of a branch or tag ref (`refs/heads/main` → `main`); any other
 * namespace comes back unchanged, which keeps PR refs structurally
 * unmatchable by short-name patterns (spec §12a).
 */
export function shortRefName(ref: string): string {
  if (ref.startsWith(BRANCH_REF_PREFIX)) {
    return ref.slice(BRANCH_REF_PREFIX.length);
  }
  if (ref.startsWith(TAG_REF_PREFIX)) {
    return ref.slice(TAG_REF_PREFIX.length);
  }
  return ref;
}
