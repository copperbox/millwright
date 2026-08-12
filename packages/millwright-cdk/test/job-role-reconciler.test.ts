import type { IAMClient } from '@aws-sdk/client-iam';
import {
  JOB_ROLE_TAG_KEYS,
  JobRoleSecretGrants,
  PolicyDocument,
  fullPolicyDocument,
  jobRolePolicyHash,
  noSecretPolicyDocument,
} from '@copperbox/millwright-state';
import { describe, expect, it } from 'vitest';
import {
  JobRoleReconciler,
  JobRoleReconcilerConfig,
  UntrustedRefError,
} from '../src/runtime/job-roles/reconciler';

const BOUNDARY_ARN = 'arn:aws:iam::123456789012:policy/team-boundary';

const CONFIG: JobRoleReconcilerConfig = {
  deploymentName: 'millwright',
  permissionsBoundaryArn: BOUNDARY_ARN,
  policyContext: {
    region: 'eu-west-1',
    accountId: '123456789012',
    artifactBucketName: 'millwright-artifacts',
    eventBusArn: 'arn:aws:events:eu-west-1:123456789012:event-bus/millwright',
    buildLogGroupArn:
      'arn:aws:logs:eu-west-1:123456789012:log-group:/millwright/millwright/builds',
  },
};

const SCOPE = { repo: 'octocat/app', workflow: 'ci', job: 'build' };
const IDENTITY = { deploymentName: 'millwright', ...SCOPE };

const GRANTS: JobRoleSecretGrants = {
  secretParameterArns: [
    'arn:aws:ssm:eu-west-1:123456789012:parameter/millwright/millwright/secrets/octocat/app/NPM_TOKEN',
  ],
  configKeyArn: 'arn:aws:kms:eu-west-1:123456789012:key/1111-2222',
};

type Sent = { name: string; input: Record<string, any> };

/** Scripted IAM client: each send shifts the next behavior. */
function fakeClient(behaviors: Array<{ result?: unknown; error?: Error }>): {
  client: IAMClient;
  sent: Sent[];
} {
  const sent: Sent[] = [];
  const client = {
    send: async (command: { input: Record<string, any> }) => {
      sent.push({ name: command.constructor.name, input: command.input });
      const behavior = behaviors.shift() ?? {};
      if (behavior.error) {
        throw behavior.error;
      }
      return behavior.result ?? {};
    },
  } as unknown as IAMClient;
  return { client, sent };
}

function namedError(name: string): Error {
  return Object.assign(new Error(name), { name });
}

const ROLE_ARN = 'arn:aws:iam::123456789012:role/millwright/millwright/jobs/mw-test';

function existingRole(policy: PolicyDocument, extraTags: Array<{ Key: string; Value: string }> = []) {
  return {
    Role: {
      Arn: ROLE_ARN,
      Tags: [
        { Key: JOB_ROLE_TAG_KEYS.policyHash, Value: jobRolePolicyHash(policy) },
        ...extraTags,
      ],
    },
  };
}

describe('ensureNoSecretRole', () => {
  it('creates a missing role: boundary-attached, on the jobs path, tagged, then policied', async () => {
    const { client, sent } = fakeClient([
      { error: namedError('NoSuchEntityException') }, // GetRole
      { result: { Role: { Arn: ROLE_ARN } } }, // CreateRole
      {}, // PutRolePolicy
    ]);
    const result = await new JobRoleReconciler(client, CONFIG).ensureNoSecretRole(SCOPE);

    expect(result.outcome).toBe('created');
    expect(result.roleArn).toBe(ROLE_ARN);
    expect(sent.map((s) => s.name)).toEqual([
      'GetRoleCommand',
      'CreateRoleCommand',
      'PutRolePolicyCommand',
    ]);

    const create = sent[1].input;
    expect(create.RoleName).toMatch(/^mw-octocat-app-ci-build-[0-9a-f]{12}-ns$/);
    expect(create.Path).toBe('/millwright/millwright/jobs/');
    expect(create.PermissionsBoundary).toBe(BOUNDARY_ARN);
    expect(JSON.parse(create.AssumeRolePolicyDocument).Statement[0].Principal).toEqual({
      Service: 'codebuild.amazonaws.com',
    });
    const tags = Object.fromEntries(create.Tags.map((t: any) => [t.Key, t.Value]));
    expect(tags[JOB_ROLE_TAG_KEYS.variant]).toBe('no-secret');
    expect(tags[JOB_ROLE_TAG_KEYS.repo]).toBe('octocat/app');
    expect(tags[JOB_ROLE_TAG_KEYS.policyHash]).toBe(result.policyHash);

    const policy = JSON.parse(sent[2].input.PolicyDocument);
    expect(policy).toEqual(noSecretPolicyDocument(IDENTITY, CONFIG.policyContext));
  });

  it('leaves a role with a matching policy hash untouched', async () => {
    const policy = noSecretPolicyDocument(IDENTITY, CONFIG.policyContext);
    const { client, sent } = fakeClient([{ result: existingRole(policy) }]);
    const result = await new JobRoleReconciler(client, CONFIG).ensureNoSecretRole(SCOPE);

    expect(result.outcome).toBe('unchanged');
    expect(sent.map((s) => s.name)).toEqual(['GetRoleCommand']);
  });

  it('updates the policy and hash tag on mismatch', async () => {
    const stale = noSecretPolicyDocument(IDENTITY, {
      ...CONFIG.policyContext,
      ecrPullRepoArns: ['arn:aws:ecr:eu-west-1:123456789012:repository/old'],
    });
    const { client, sent } = fakeClient([
      { result: existingRole(stale) }, // GetRole
      {}, // PutRolePolicy
      {}, // TagRole
    ]);
    const result = await new JobRoleReconciler(client, CONFIG).ensureNoSecretRole(SCOPE);

    expect(result.outcome).toBe('updated');
    expect(sent.map((s) => s.name)).toEqual([
      'GetRoleCommand',
      'PutRolePolicyCommand',
      'TagRoleCommand',
    ]);
    expect(sent[2].input.Tags).toEqual([
      { Key: JOB_ROLE_TAG_KEYS.policyHash, Value: result.policyHash },
    ]);
  });

  it('clears the sweep orphan marker when reconciling a marked role', async () => {
    const policy = noSecretPolicyDocument(IDENTITY, CONFIG.policyContext);
    const { client, sent } = fakeClient([
      {
        result: existingRole(policy, [
          { Key: JOB_ROLE_TAG_KEYS.orphanedAt, Value: '2026-08-01T00:00:00Z' },
        ]),
      },
      {}, // UntagRole
    ]);
    const result = await new JobRoleReconciler(client, CONFIG).ensureNoSecretRole(SCOPE);

    expect(result.outcome).toBe('unchanged');
    expect(sent[1].name).toBe('UntagRoleCommand');
    expect(sent[1].input.TagKeys).toEqual([JOB_ROLE_TAG_KEYS.orphanedAt]);
  });

  it('falls to the update path after losing a create race', async () => {
    const stale = { Version: '2012-10-17', Statement: [] } as unknown as PolicyDocument;
    const { client, sent } = fakeClient([
      { error: namedError('NoSuchEntityException') }, // GetRole
      { error: namedError('EntityAlreadyExistsException') }, // CreateRole
      { result: existingRole(stale) }, // GetRole (re-read)
      {}, // PutRolePolicy
      {}, // TagRole
    ]);
    const result = await new JobRoleReconciler(client, CONFIG).ensureNoSecretRole(SCOPE);

    expect(result.outcome).toBe('updated');
    expect(result.roleArn).toBe(ROLE_ARN);
    expect(sent.map((s) => s.name)).toEqual([
      'GetRoleCommand',
      'CreateRoleCommand',
      'GetRoleCommand',
      'PutRolePolicyCommand',
      'TagRoleCommand',
    ]);
  });

  it('omits the boundary parameter only under Boundary.NONE', async () => {
    const { client, sent } = fakeClient([
      { error: namedError('NoSuchEntityException') },
      { result: { Role: { Arn: ROLE_ARN } } },
      {},
    ]);
    await new JobRoleReconciler(client, {
      ...CONFIG,
      permissionsBoundaryArn: undefined,
    }).ensureNoSecretRole(SCOPE);
    expect(sent[1].input.PermissionsBoundary).toBeUndefined();
  });
});

describe('ensureFullRole', () => {
  const RUN = { ref: 'refs/heads/main', secretsAllowedRefs: ['main'] };

  it('creates the full variant with the model-declared secret grants', async () => {
    const { client, sent } = fakeClient([
      { error: namedError('NoSuchEntityException') },
      { result: { Role: { Arn: ROLE_ARN } } },
      {},
    ]);
    const result = await new JobRoleReconciler(client, CONFIG).ensureFullRole(
      SCOPE,
      RUN,
      GRANTS,
    );

    expect(result.outcome).toBe('created');
    expect(sent[1].input.RoleName).toMatch(/-fg$/);
    const policy = JSON.parse(sent[2].input.PolicyDocument);
    expect(policy).toEqual(fullPolicyDocument(IDENTITY, CONFIG.policyContext, GRANTS));
  });

  it('refuses untrusted refs before any IAM call', async () => {
    const { client, sent } = fakeClient([]);
    const reconciler = new JobRoleReconciler(client, CONFIG);

    await expect(
      reconciler.ensureFullRole(SCOPE, { ref: 'refs/pull/42/merge', secretsAllowedRefs: ['*'] }, GRANTS),
    ).rejects.toThrow(UntrustedRefError);
    await expect(
      reconciler.ensureFullRole(SCOPE, { ref: 'refs/heads/main', secretsAllowedRefs: undefined }, GRANTS),
    ).rejects.toThrow(UntrustedRefError);
    await expect(
      reconciler.ensureFullRole(SCOPE, { ref: 'refs/heads/feature', secretsAllowedRefs: ['main'] }, GRANTS),
    ).rejects.toThrow(UntrustedRefError);
    expect(sent).toEqual([]);
  });

  it('is idempotent across repeated trusted synths of the same model', async () => {
    const policy = fullPolicyDocument(IDENTITY, CONFIG.policyContext, GRANTS);
    const { client, sent } = fakeClient([{ result: existingRole(policy) }]);
    const result = await new JobRoleReconciler(client, CONFIG).ensureFullRole(
      SCOPE,
      RUN,
      GRANTS,
    );
    expect(result.outcome).toBe('unchanged');
    expect(sent).toHaveLength(1);
  });

  it('reconciles a hash mismatch when a trusted model changes its grants', async () => {
    const stale = fullPolicyDocument(IDENTITY, CONFIG.policyContext, {
      ...GRANTS,
      secretParameterArns: [],
    });
    const { client, sent } = fakeClient([
      { result: existingRole(stale) },
      {}, // PutRolePolicy
      {}, // TagRole
    ]);
    const result = await new JobRoleReconciler(client, CONFIG).ensureFullRole(
      SCOPE,
      RUN,
      GRANTS,
    );
    expect(result.outcome).toBe('updated');
    const updated = JSON.parse(sent[1].input.PolicyDocument);
    expect(updated).toEqual(fullPolicyDocument(IDENTITY, CONFIG.policyContext, GRANTS));
  });
});
