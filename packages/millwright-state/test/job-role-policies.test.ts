import { describe, expect, it } from 'vitest';
import {
  JobRoleIdentity,
  JobRolePolicyContext,
  JobRoleSecretGrants,
  PolicyDocument,
  fullPolicyDocument,
  jobRolePolicyHash,
  jobRoleTrustPolicy,
  noSecretPolicyDocument,
} from '../src';

const IDENTITY: JobRoleIdentity = {
  deploymentName: 'millwright',
  repo: 'octocat/app',
  workflow: 'ci',
  job: 'build',
};

const CONTEXT: JobRolePolicyContext = {
  region: 'eu-west-1',
  accountId: '123456789012',
  artifactBucketName: 'millwright-artifacts-123456789012-eu-west-1',
  eventBusArn: 'arn:aws:events:eu-west-1:123456789012:event-bus/millwright',
  buildLogGroupArn:
    'arn:aws:logs:eu-west-1:123456789012:log-group:/millwright/millwright/builds',
};

const GRANTS: JobRoleSecretGrants = {
  secretParameterArns: [
    'arn:aws:ssm:eu-west-1:123456789012:parameter/millwright/millwright/secrets/octocat/app/NPM_TOKEN',
  ],
  configKeyArn: 'arn:aws:kms:eu-west-1:123456789012:key/1111-2222',
  passthroughSecretArns: ['arn:aws:secretsmanager:eu-west-1:123456789012:secret:legacy-AbCdEf'],
};

function statement(document: PolicyDocument, sid: string) {
  return document.Statement.find((s) => s.Sid === sid);
}

const BUCKET = `arn:aws:s3:::${CONTEXT.artifactBucketName}`;

describe('noSecretPolicyDocument', () => {
  const doc = noSecretPolicyDocument(IDENTITY, CONTEXT);

  it('reads run inputs and run-wide artifacts, writes only its own out/<job>/', () => {
    expect(statement(doc, 'RunInputRead')?.Resource).toEqual([
      `${BUCKET}/runs/octocat/app/ci/*/in/*`,
    ]);
    expect(statement(doc, 'RunArtifactRead')?.Resource).toEqual([
      `${BUCKET}/runs/octocat/app/ci/*/out/*`,
    ]);
    expect(statement(doc, 'JobOutputWrite')?.Action).toEqual(['s3:PutObject']);
    expect(statement(doc, 'JobOutputWrite')?.Resource).toEqual([
      `${BUCKET}/runs/octocat/app/ci/*/out/build/*`,
    ]);
  });

  it('scopes cache access to the repo with a prefix-conditioned ListBucket', () => {
    expect(statement(doc, 'CacheReadWrite')?.Resource).toEqual([
      `${BUCKET}/cache/octocat/app/*`,
    ]);
    expect(statement(doc, 'CacheList')?.Condition).toEqual({
      StringLike: { 's3:prefix': ['cache/octocat/app/*'] },
    });
  });

  it('conditions PutEvents to source millwright.step', () => {
    expect(statement(doc, 'StepEvents')?.Condition).toEqual({
      StringEquals: { 'events:source': 'millwright.step' },
    });
  });

  it('denies deploy-key reads explicitly, across all deployments', () => {
    const deny = statement(doc, 'DenyDeployKeys');
    expect(deny?.Effect).toBe('Deny');
    expect(deny?.Resource).toEqual([
      'arn:aws:ssm:eu-west-1:123456789012:parameter/millwright/*/repos/*/deploy-key',
    ]);
  });

  it('grants no DynamoDB, SSM-read, KMS, or Secrets Manager access', () => {
    const allowedActions = doc.Statement.filter((s) => s.Effect === 'Allow').flatMap(
      (s) => s.Action,
    );
    for (const action of allowedActions) {
      expect(action).not.toMatch(/^dynamodb:|^ssm:|^kms:|^secretsmanager:/);
    }
  });

  it('omits ECR statements unless the operator allowlisted pull repos', () => {
    expect(statement(doc, 'EcrPull')).toBeUndefined();
    expect(statement(doc, 'EcrAuth')).toBeUndefined();

    const withEcr = noSecretPolicyDocument(IDENTITY, {
      ...CONTEXT,
      ecrPullRepoArns: ['arn:aws:ecr:eu-west-1:123456789012:repository/tools'],
    });
    expect(statement(withEcr, 'EcrPull')?.Resource).toEqual([
      'arn:aws:ecr:eu-west-1:123456789012:repository/tools',
    ]);
    expect(statement(withEcr, 'EcrAuth')?.Resource).toEqual(['*']);
  });
});

describe('fullPolicyDocument', () => {
  const doc = fullPolicyDocument(IDENTITY, CONTEXT, GRANTS);

  it('adds GetParameters (plural) on exactly the declared params plus kms:Decrypt', () => {
    expect(statement(doc, 'SecretParameterRead')?.Action).toEqual(['ssm:GetParameters']);
    expect(statement(doc, 'SecretParameterRead')?.Resource).toEqual(GRANTS.secretParameterArns);
    expect(statement(doc, 'SecretDecrypt')?.Resource).toEqual([GRANTS.configKeyArn]);
  });

  it('adds GetSecretValue on declared passthrough ARNs', () => {
    expect(statement(doc, 'PassthroughSecretRead')?.Resource).toEqual(
      GRANTS.passthroughSecretArns,
    );
  });

  it('keeps the whole no-secret baseline, including the deploy-key Deny', () => {
    const base = noSecretPolicyDocument(IDENTITY, CONTEXT);
    for (const sid of base.Statement.map((s) => s.Sid)) {
      expect(statement(doc, sid as string)).toBeDefined();
    }
  });

  it('collapses to the baseline shape when a trusted model declares no secrets', () => {
    const bare = fullPolicyDocument(IDENTITY, CONTEXT, {
      secretParameterArns: [],
      configKeyArn: GRANTS.configKeyArn,
    });
    expect(bare).toEqual(noSecretPolicyDocument(IDENTITY, CONTEXT));
  });
});

describe('jobRoleTrustPolicy', () => {
  it('trusts CodeBuild only, pinned to the account', () => {
    const trust = jobRoleTrustPolicy('123456789012');
    expect(trust.Statement).toHaveLength(1);
    expect(trust.Statement[0].Principal).toEqual({ Service: 'codebuild.amazonaws.com' });
    expect(trust.Statement[0].Condition).toEqual({
      StringEquals: { 'aws:SourceAccount': '123456789012' },
    });
  });
});

describe('jobRolePolicyHash', () => {
  it('is stable for identical documents', () => {
    expect(jobRolePolicyHash(fullPolicyDocument(IDENTITY, CONTEXT, GRANTS))).toBe(
      jobRolePolicyHash(fullPolicyDocument(IDENTITY, CONTEXT, GRANTS)),
    );
  });

  it('ignores object key order but not content', () => {
    const a = { Version: '2012-10-17', Statement: [{ Effect: 'Allow', Action: ['s3:GetObject'] }] };
    const b = { Statement: [{ Action: ['s3:GetObject'], Effect: 'Allow' }], Version: '2012-10-17' };
    expect(jobRolePolicyHash(a as PolicyDocument)).toBe(jobRolePolicyHash(b as PolicyDocument));
  });

  it('changes when the declared grants change', () => {
    const changed = fullPolicyDocument(IDENTITY, CONTEXT, {
      ...GRANTS,
      secretParameterArns: [
        ...GRANTS.secretParameterArns,
        'arn:aws:ssm:eu-west-1:123456789012:parameter/millwright/millwright/secrets/octocat/app/OTHER',
      ],
    });
    expect(jobRolePolicyHash(changed)).not.toBe(
      jobRolePolicyHash(fullPolicyDocument(IDENTITY, CONTEXT, GRANTS)),
    );
  });

  it('normalizes declared-ARN order and duplicates', () => {
    const shuffled = fullPolicyDocument(IDENTITY, CONTEXT, {
      ...GRANTS,
      secretParameterArns: [
        'arn:b',
        'arn:a',
        'arn:a',
      ],
    });
    const sortedGrants = fullPolicyDocument(IDENTITY, CONTEXT, {
      ...GRANTS,
      secretParameterArns: ['arn:a', 'arn:b'],
    });
    expect(jobRolePolicyHash(shuffled)).toBe(jobRolePolicyHash(sortedGrants));
  });
});
