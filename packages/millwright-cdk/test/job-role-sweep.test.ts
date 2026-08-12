import type { IAMClient } from '@aws-sdk/client-iam';
import {
  JOB_ROLE_TAG_KEYS,
  JobRoleIdentity,
  JobRoleVariant,
  jobRoleName,
  jobRoleTags,
} from '@copperbox/millwright-state';
import { describe, expect, it } from 'vitest';
import { sweepStaleJobRoles } from '../src/runtime/job-roles/sweep';

const NOW = Date.parse('2026-08-12T06:00:00Z');
const DAY_MS = 24 * 60 * 60 * 1000;

function identity(job: string): JobRoleIdentity {
  return { deploymentName: 'millwright', repo: 'octocat/app', workflow: 'ci', job };
}

type Sent = { name: string; input: Record<string, any> };

/**
 * Fake IAM with a role inventory: ListRoles pages over it, ListRoleTags reads
 * per-role tags, mutations are recorded.
 */
function fakeIam(
  roles: Array<{ identity: JobRoleIdentity; variant: JobRoleVariant; orphanedAt?: string }>,
  extras: Array<{ roleName: string; tags: Array<{ Key: string; Value: string }> }> = [],
  pageSize = 100,
): { client: IAMClient; sent: Sent[] } {
  const inventory = [
    ...roles.map((role) => ({
      roleName: jobRoleName(role.identity, role.variant),
      tags: [
        ...jobRoleTags(role.identity, role.variant),
        ...(role.orphanedAt
          ? [{ Key: JOB_ROLE_TAG_KEYS.orphanedAt, Value: role.orphanedAt }]
          : []),
      ],
    })),
    ...extras,
  ];
  const sent: Sent[] = [];
  const client = {
    send: async (command: { input: Record<string, any> }) => {
      const name = command.constructor.name;
      sent.push({ name, input: command.input });
      if (name === 'ListRolesCommand') {
        const start = command.input.Marker ? Number(command.input.Marker) : 0;
        const page = inventory.slice(start, start + pageSize);
        const truncated = start + pageSize < inventory.length;
        return {
          Roles: page.map((role) => ({ RoleName: role.roleName })),
          IsTruncated: truncated,
          Marker: truncated ? String(start + pageSize) : undefined,
        };
      }
      if (name === 'ListRoleTagsCommand') {
        const role = inventory.find((entry) => entry.roleName === command.input.RoleName);
        return { Tags: role?.tags ?? [] };
      }
      return {};
    },
  } as unknown as IAMClient;
  return { client, sent };
}

describe('sweepStaleJobRoles', () => {
  it('marks fresh orphans, keeps marked ones inside the window, deletes expired ones', async () => {
    const { client, sent } = fakeIam([
      { identity: identity('live'), variant: 'full' },
      { identity: identity('fresh-orphan'), variant: 'no-secret' },
      {
        identity: identity('waiting'),
        variant: 'full',
        orphanedAt: new Date(NOW - 29 * DAY_MS).toISOString(),
      },
      {
        identity: identity('expired'),
        variant: 'no-secret',
        orphanedAt: new Date(NOW - 30 * DAY_MS).toISOString(),
      },
    ]);

    const report = await sweepStaleJobRoles({
      client,
      deploymentName: 'millwright',
      isLive: (id) => id.job === 'live',
      nowMs: NOW,
    });

    expect(report.scanned).toBe(4);
    expect(report.live).toBe(1);
    expect(report.marked).toEqual([jobRoleName(identity('fresh-orphan'), 'no-secret')]);
    expect(report.deleted).toEqual([jobRoleName(identity('expired'), 'no-secret')]);
    expect(report.unmarked).toEqual([]);

    expect(sent[0].input.PathPrefix).toBe('/millwright/millwright/jobs/');
    const mark = sent.find((s) => s.name === 'TagRoleCommand');
    expect(mark?.input.Tags).toEqual([
      { Key: JOB_ROLE_TAG_KEYS.orphanedAt, Value: new Date(NOW).toISOString() },
    ]);
    // Deletion clears the inline policy first, then the role.
    const deletions = sent.filter((s) => s.name.startsWith('Delete')).map((s) => s.name);
    expect(deletions).toEqual(['DeleteRolePolicyCommand', 'DeleteRoleCommand']);
  });

  it('clears the orphan marker when a marked role turns up live again', async () => {
    const { client, sent } = fakeIam([
      {
        identity: identity('revived'),
        variant: 'full',
        orphanedAt: new Date(NOW - 10 * DAY_MS).toISOString(),
      },
    ]);
    const report = await sweepStaleJobRoles({
      client,
      deploymentName: 'millwright',
      isLive: () => true,
      nowMs: NOW,
    });
    expect(report.unmarked).toEqual([jobRoleName(identity('revived'), 'full')]);
    expect(report.deleted).toEqual([]);
    const untag = sent.find((s) => s.name === 'UntagRoleCommand');
    expect(untag?.input.TagKeys).toEqual([JOB_ROLE_TAG_KEYS.orphanedAt]);
  });

  it('never touches roles missing millwright identity tags', async () => {
    const { client, sent } = fakeIam(
      [],
      [{ roleName: 'mw-somebody-elses-role', tags: [{ Key: 'team', Value: 'ops' }] }],
    );
    const report = await sweepStaleJobRoles({
      client,
      deploymentName: 'millwright',
      isLive: () => false,
      nowMs: NOW,
    });
    expect(report.skipped).toEqual(['mw-somebody-elses-role']);
    expect(sent.map((s) => s.name)).toEqual(['ListRolesCommand', 'ListRoleTagsCommand']);
  });

  it('paginates ListRoles to the end', async () => {
    const roles = Array.from({ length: 5 }, (_, i) => ({
      identity: identity(`job-${i}`),
      variant: 'full' as const,
    }));
    const { client, sent } = fakeIam(roles, [], 2);
    const report = await sweepStaleJobRoles({
      client,
      deploymentName: 'millwright',
      isLive: () => true,
      nowMs: NOW,
    });
    expect(report.scanned).toBe(5);
    expect(sent.filter((s) => s.name === 'ListRolesCommand')).toHaveLength(3);
  });

  it('respects a custom retention window', async () => {
    const { client } = fakeIam([
      {
        identity: identity('old'),
        variant: 'full',
        orphanedAt: new Date(NOW - 8 * DAY_MS).toISOString(),
      },
    ]);
    const report = await sweepStaleJobRoles({
      client,
      deploymentName: 'millwright',
      isLive: () => false,
      nowMs: NOW,
      retentionDays: 7,
    });
    expect(report.deleted).toHaveLength(1);
  });
});
