import type { IAMClient } from '@aws-sdk/client-iam';
import {
  DeleteRoleCommand,
  DeleteRolePolicyCommand,
  ListRolesCommand,
  ListRoleTagsCommand,
  TagRoleCommand,
  UntagRoleCommand,
} from '@aws-sdk/client-iam';
import {
  JOB_ROLE_INLINE_POLICY_NAME,
  JOB_ROLE_TAG_KEYS,
  JobRoleIdentity,
  JobRoleVariant,
  STALE_JOB_ROLE_RETENTION_DAYS,
  jobRoleIdentityFromTags,
  jobRolePath,
} from '@copperbox/millwright-state';

/**
 * Stale job-role housekeeping (spec §10.2): the sweep deletes role pairs
 * whose (workflow, job) no longer appears in any registry entry — after a
 * 30-day grace, not immediately, so a briefly-deleted workflow's roles (and
 * their operator-side ECR resource-policy references) survive a revert.
 *
 * Two-phase by design: an orphan is first MARKED (`millwright:orphaned-at`
 * tag) and only deleted once the mark is `retentionDays` old. Liveness is a
 * caller-supplied predicate over the role's identity tags, so this module
 * needs no registry schema; roles missing millwright's tags are never
 * touched. Deletion clears the inline policy first (IAM refuses otherwise).
 */

export interface SweepJobRolesInput {
  readonly client: IAMClient;
  readonly deploymentName: string;
  /** Does this identity still appear in any registry entry? */
  readonly isLive: (identity: JobRoleIdentity, variant: JobRoleVariant) => boolean;
  readonly nowMs: number;
  /** @default STALE_JOB_ROLE_RETENTION_DAYS */
  readonly retentionDays?: number;
}

export interface JobRoleSweepReport {
  /** Every role under the deployment's job-role path — `doctor`'s role count. */
  readonly scanned: number;
  readonly live: number;
  /** Newly orphan-marked this sweep. */
  readonly marked: string[];
  /** Live again; orphan mark cleared. */
  readonly unmarked: string[];
  /** Deleted after the retention window. */
  readonly deleted: string[];
  /** Under the path but missing millwright's tags; never touched. */
  readonly skipped: string[];
}

function errorName(error: unknown): string {
  return error instanceof Error ? error.name : '';
}

export async function sweepStaleJobRoles(input: SweepJobRolesInput): Promise<JobRoleSweepReport> {
  const retentionMs =
    (input.retentionDays ?? STALE_JOB_ROLE_RETENTION_DAYS) * 24 * 60 * 60 * 1000;
  let scanned = 0;
  let live = 0;
  const marked: string[] = [];
  const unmarked: string[] = [];
  const deleted: string[] = [];
  const skipped: string[] = [];

  let marker: string | undefined;
  do {
    const page = await input.client.send(
      new ListRolesCommand({ PathPrefix: jobRolePath(input.deploymentName), Marker: marker }),
    );
    marker = page.IsTruncated ? page.Marker : undefined;
    for (const role of page.Roles ?? []) {
      const roleName = role.RoleName;
      if (!roleName) {
        continue;
      }
      scanned += 1;

      const tags = (
        await input.client.send(new ListRoleTagsCommand({ RoleName: roleName }))
      ).Tags;
      const parsed = jobRoleIdentityFromTags(tags);
      if (!parsed) {
        skipped.push(roleName);
        continue;
      }

      const orphanedAt = tags?.find((tag) => tag.Key === JOB_ROLE_TAG_KEYS.orphanedAt)?.Value;
      if (input.isLive(parsed.identity, parsed.variant)) {
        live += 1;
        if (orphanedAt !== undefined) {
          await input.client.send(
            new UntagRoleCommand({ RoleName: roleName, TagKeys: [JOB_ROLE_TAG_KEYS.orphanedAt] }),
          );
          unmarked.push(roleName);
        }
        continue;
      }

      const orphanedSince = orphanedAt === undefined ? NaN : Date.parse(orphanedAt);
      if (Number.isNaN(orphanedSince)) {
        // Not yet marked (or an unreadable mark): (re)start the clock.
        await input.client.send(
          new TagRoleCommand({
            RoleName: roleName,
            Tags: [
              {
                Key: JOB_ROLE_TAG_KEYS.orphanedAt,
                Value: new Date(input.nowMs).toISOString(),
              },
            ],
          }),
        );
        marked.push(roleName);
        continue;
      }

      if (input.nowMs - orphanedSince < retentionMs) {
        continue; // marked, still inside the grace window
      }

      try {
        await input.client.send(
          new DeleteRolePolicyCommand({
            RoleName: roleName,
            PolicyName: JOB_ROLE_INLINE_POLICY_NAME,
          }),
        );
      } catch (error) {
        if (errorName(error) !== 'NoSuchEntityException') {
          throw error;
        }
      }
      await input.client.send(new DeleteRoleCommand({ RoleName: roleName }));
      deleted.push(roleName);
    }
  } while (marker !== undefined);

  return { scanned, live, marked, unmarked, deleted, skipped };
}
