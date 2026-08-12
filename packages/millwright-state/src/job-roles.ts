import { createHash } from 'node:crypto';
import { KeyFormatError } from './keys';

/**
 * Stable job-role identity and naming (spec §10.2). Per-run role creation is
 * dropped; every user job runs under one of exactly two standing roles per
 * (repo, workflow, job):
 *
 * - `full` — full-grants: the no-secret baseline PLUS the model-declared
 *   secret grants; created/updated only from validated models of allowlisted
 *   refs.
 * - `no-secret` — no-secret-grants: nothing model-derived; what untrusted
 *   refs (PRs included) dispatch under.
 *
 * Names are deterministic under the `mw-*` namespace, truncated and hashed to
 * IAM's 64-char limit, and every role sits on the deployment's IAM path so
 * the sweep and `doctor` enumerate them with one `ListRoles` PathPrefix.
 */

export const JOB_ROLE_VARIANTS = ['full', 'no-secret'] as const;
export type JobRoleVariant = (typeof JOB_ROLE_VARIANTS)[number];

/** One stable role pair's identity. */
export interface JobRoleIdentity {
  readonly deploymentName: string;
  /** Watched repo as `owner/name`. */
  readonly repo: string;
  readonly workflow: string;
  readonly job: string;
}

export const JOB_ROLE_NAME_PREFIX = 'mw-';

/** IAM caps role names at 64 characters. */
export const JOB_ROLE_NAME_MAX_LENGTH = 64;

/** Roles absent from every registry entry this long are deleted by the sweep. */
export const STALE_JOB_ROLE_RETENTION_DAYS = 30;

/** Name of the single inline policy every job role carries. */
export const JOB_ROLE_INLINE_POLICY_NAME = 'millwright-job';

/** Tag keys stamped on every job role millwright creates. */
export const JOB_ROLE_TAG_KEYS = {
  deployment: 'millwright:deployment',
  repo: 'millwright:repo',
  workflow: 'millwright:workflow',
  job: 'millwright:job',
  variant: 'millwright:variant',
  /** Hash of the role's inline policy document; the dispatch-time reconcile key. */
  policyHash: 'millwright:policy-hash',
  /** ISO timestamp of when the sweep first found the role orphaned. */
  orphanedAt: 'millwright:orphaned-at',
} as const;

const VARIANT_SUFFIXES: Record<JobRoleVariant, string> = {
  full: 'fg',
  'no-secret': 'ns',
};

function assertIdentity(identity: JobRoleIdentity): void {
  if (!identity.deploymentName || identity.deploymentName.includes('/')) {
    throw new KeyFormatError(
      `deploymentName must be non-empty and free of "/", got "${identity.deploymentName}"`,
    );
  }
  if (!identity.repo || !/^[^/]+\/[^/]+$/.test(identity.repo)) {
    throw new KeyFormatError(`repo must be "owner/name", got "${identity.repo}"`);
  }
  for (const [label, value] of [
    ['workflow', identity.workflow],
    ['job', identity.job],
  ] as const) {
    if (!value || value.includes('/')) {
      throw new KeyFormatError(`${label} must be non-empty and free of "/", got "${value}"`);
    }
  }
}

/**
 * IAM path shared by every job role of one deployment:
 * `/millwright/<deploymentName>/jobs/`. `ListRoles` with this PathPrefix is
 * the sweep's and `doctor`'s enumeration; the decider's `iam:*` and
 * `iam:PassRole` grants are scoped to ARNs under it.
 */
export function jobRolePath(deploymentName: string): string {
  if (!deploymentName || !/^[a-z][a-z0-9-]{0,62}$/.test(deploymentName)) {
    throw new KeyFormatError(
      `deploymentName must match [a-z][a-z0-9-]* (max 63 chars), got "${deploymentName}"`,
    );
  }
  return `/millwright/${deploymentName}/jobs/`;
}

/**
 * Hash of the full identity tuple, keeping names unique after the readable
 * slug is truncated. 12 hex chars (48 bits) is far beyond the ~500-role scale
 * the quota arithmetic anticipates.
 */
function identityHash(identity: JobRoleIdentity): string {
  return createHash('sha256')
    .update(
      [identity.deploymentName, identity.repo, identity.workflow, identity.job].join('\n'),
      'utf8',
    )
    .digest('hex')
    .slice(0, 12);
}

function slugify(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

/**
 * Deterministic role name: `mw-<slug>-<hash12>-<fg|ns>`, always ≤ 64 chars.
 *
 * The slug is human legibility only (`<repo>-<workflow>-<job>`, lowercased,
 * truncated); uniqueness and stability come from the hash over the full
 * identity tuple, so truncation collisions and IAM's case-insensitive name
 * uniqueness cannot alias two role pairs.
 */
export function jobRoleName(identity: JobRoleIdentity, variant: JobRoleVariant): string {
  assertIdentity(identity);
  const suffix = `-${identityHash(identity)}-${VARIANT_SUFFIXES[variant]}`;
  const budget = JOB_ROLE_NAME_MAX_LENGTH - JOB_ROLE_NAME_PREFIX.length - suffix.length;
  const slug = slugify(`${identity.repo}-${identity.workflow}-${identity.job}`)
    .slice(0, budget)
    .replace(/-+$/, '');
  return `${JOB_ROLE_NAME_PREFIX}${slug}${suffix}`;
}

/** Both variant names of one identity, full first. */
export function jobRoleNamePair(identity: JobRoleIdentity): Record<JobRoleVariant, string> {
  return {
    full: jobRoleName(identity, 'full'),
    'no-secret': jobRoleName(identity, 'no-secret'),
  };
}

/** The identity/variant tags stamped at role creation. */
export function jobRoleTags(
  identity: JobRoleIdentity,
  variant: JobRoleVariant,
): Array<{ Key: string; Value: string }> {
  assertIdentity(identity);
  return [
    { Key: JOB_ROLE_TAG_KEYS.deployment, Value: identity.deploymentName },
    { Key: JOB_ROLE_TAG_KEYS.repo, Value: identity.repo },
    { Key: JOB_ROLE_TAG_KEYS.workflow, Value: identity.workflow },
    { Key: JOB_ROLE_TAG_KEYS.job, Value: identity.job },
    { Key: JOB_ROLE_TAG_KEYS.variant, Value: variant },
  ];
}

/**
 * Inverse of `jobRoleTags`, for the sweep reading roles back from IAM.
 * Undefined when any identity tag is missing or the variant is unknown —
 * such roles are never millwright's to manage.
 */
export function jobRoleIdentityFromTags(
  tags: ReadonlyArray<{ Key?: string; Value?: string }> | undefined,
): { identity: JobRoleIdentity; variant: JobRoleVariant } | undefined {
  const byKey = new Map((tags ?? []).map((tag) => [tag.Key, tag.Value]));
  const deploymentName = byKey.get(JOB_ROLE_TAG_KEYS.deployment);
  const repo = byKey.get(JOB_ROLE_TAG_KEYS.repo);
  const workflow = byKey.get(JOB_ROLE_TAG_KEYS.workflow);
  const job = byKey.get(JOB_ROLE_TAG_KEYS.job);
  const variant = byKey.get(JOB_ROLE_TAG_KEYS.variant);
  if (!deploymentName || !repo || !workflow || !job) {
    return undefined;
  }
  if (variant !== 'full' && variant !== 'no-secret') {
    return undefined;
  }
  return { identity: { deploymentName, repo, workflow, job }, variant };
}
