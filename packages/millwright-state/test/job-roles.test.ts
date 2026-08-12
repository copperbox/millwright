import { describe, expect, it } from 'vitest';
import {
  JOB_ROLE_NAME_MAX_LENGTH,
  JOB_ROLE_TAG_KEYS,
  JobRoleIdentity,
  jobRoleIdentityFromTags,
  jobRoleName,
  jobRoleNamePair,
  jobRolePath,
  jobRoleTags,
} from '../src';

const IDENTITY: JobRoleIdentity = {
  deploymentName: 'millwright',
  repo: 'octocat/app',
  workflow: 'ci',
  job: 'build',
};

describe('jobRoleName', () => {
  it('is deterministic and stable across calls', () => {
    expect(jobRoleName(IDENTITY, 'full')).toBe(jobRoleName({ ...IDENTITY }, 'full'));
  });

  it('lives under the mw-* namespace with a variant suffix', () => {
    expect(jobRoleName(IDENTITY, 'full')).toMatch(/^mw-octocat-app-ci-build-[0-9a-f]{12}-fg$/);
    expect(jobRoleName(IDENTITY, 'no-secret')).toMatch(
      /^mw-octocat-app-ci-build-[0-9a-f]{12}-ns$/,
    );
  });

  it('gives the two variants the same stem, differing only in suffix', () => {
    const pair = jobRoleNamePair(IDENTITY);
    expect(pair.full.slice(0, -2)).toBe(pair['no-secret'].slice(0, -2));
  });

  it('truncates long identities into the 64-char IAM limit', () => {
    const long = {
      deploymentName: 'millwright',
      repo: `${'o'.repeat(39)}/${'r'.repeat(100)}`,
      workflow: 'w'.repeat(80),
      job: 'j'.repeat(80),
    };
    const name = jobRoleName(long, 'full');
    expect(name.length).toBeLessThanOrEqual(JOB_ROLE_NAME_MAX_LENGTH);
    expect(name).toMatch(/^mw-/);
    expect(name).toMatch(/-fg$/);
  });

  it('keeps truncation-colliding identities distinct via the hash', () => {
    const base = {
      deploymentName: 'millwright',
      repo: `octocat/${'r'.repeat(60)}`,
      workflow: 'w'.repeat(60),
    };
    const a = jobRoleName({ ...base, job: 'alpha' }, 'full');
    const b = jobRoleName({ ...base, job: 'beta' }, 'full');
    expect(a).not.toBe(b);
  });

  it('distinguishes identities that only differ by case', () => {
    const upper = jobRoleName({ ...IDENTITY, job: 'Build' }, 'full');
    const lower = jobRoleName(IDENTITY, 'full');
    expect(upper).not.toBe(lower);
    expect(upper.toLowerCase()).toBe(upper); // names are emitted lowercase
  });

  it('sanitizes characters IAM role names reject', () => {
    const name = jobRoleName({ ...IDENTITY, job: 'build & test!' }, 'no-secret');
    expect(name).toMatch(/^[a-z0-9-]+$/);
  });

  it('rejects malformed identities', () => {
    expect(() => jobRoleName({ ...IDENTITY, repo: 'no-owner' }, 'full')).toThrow(/owner\/name/);
    expect(() => jobRoleName({ ...IDENTITY, job: '' }, 'full')).toThrow(/job/);
    expect(() => jobRoleName({ ...IDENTITY, workflow: 'a/b' }, 'full')).toThrow(/workflow/);
    expect(() => jobRoleName({ ...IDENTITY, deploymentName: '' }, 'full')).toThrow(
      /deploymentName/,
    );
  });
});

describe('jobRolePath', () => {
  it('namespaces roles by deployment', () => {
    expect(jobRolePath('millwright')).toBe('/millwright/millwright/jobs/');
    expect(jobRolePath('staging')).toBe('/millwright/staging/jobs/');
  });

  it('rejects names that would corrupt the path', () => {
    expect(() => jobRolePath('Bad/Name')).toThrow(/deploymentName/);
    expect(() => jobRolePath('')).toThrow(/deploymentName/);
  });
});

describe('jobRoleTags / jobRoleIdentityFromTags', () => {
  it('round-trips identity and variant through tags', () => {
    const tags = jobRoleTags(IDENTITY, 'no-secret');
    expect(jobRoleIdentityFromTags(tags)).toEqual({ identity: IDENTITY, variant: 'no-secret' });
  });

  it('refuses roles missing millwright identity tags', () => {
    expect(jobRoleIdentityFromTags(undefined)).toBeUndefined();
    expect(jobRoleIdentityFromTags([])).toBeUndefined();
    expect(
      jobRoleIdentityFromTags([{ Key: JOB_ROLE_TAG_KEYS.repo, Value: 'octocat/app' }]),
    ).toBeUndefined();
  });

  it('refuses unknown variants', () => {
    const tags = jobRoleTags(IDENTITY, 'full').map((tag) =>
      tag.Key === JOB_ROLE_TAG_KEYS.variant ? { ...tag, Value: 'admin' } : tag,
    );
    expect(jobRoleIdentityFromTags(tags)).toBeUndefined();
  });
});
