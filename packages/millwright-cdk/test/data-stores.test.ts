import { App, Duration, Stack } from 'aws-cdk-lib';
import { Annotations, Match, Template } from 'aws-cdk-lib/assertions';
import { describe, expect, it } from 'vitest';
import { Millwright, MillwrightProps } from '../src';

const BOUNDARY_ARN = 'arn:aws:iam::123456789012:policy/team-boundary';

function templateFor(props: Partial<MillwrightProps> = {}): {
  stack: Stack;
  millwright: Millwright;
  template: Template;
} {
  const stack = new Stack(new App(), 'Test');
  const millwright = new Millwright(stack, 'Millwright', {
    permissionsBoundary: BOUNDARY_ARN,
    ...props,
  });
  return { stack, millwright, template: Template.fromStack(stack) };
}

describe('state table (C9)', () => {
  it('is single-table, on-demand, streamed, TTL on expiresAt', () => {
    const { template } = templateFor();
    template.hasResourceProperties('AWS::DynamoDB::Table', {
      TableName: 'millwright-state',
      BillingMode: 'PAY_PER_REQUEST',
      KeySchema: [
        { AttributeName: 'pk', KeyType: 'HASH' },
        { AttributeName: 'sk', KeyType: 'RANGE' },
      ],
      StreamSpecification: { StreamViewType: 'NEW_AND_OLD_IMAGES' },
      TimeToLiveSpecification: { AttributeName: 'expiresAt', Enabled: true },
    });
  });

  it('is never a credential store: no CMK encryption, and no GSIs', () => {
    const { template } = templateFor();
    const table = Object.values(template.findResources('AWS::DynamoDB::Table')).find(
      (t) => t.Properties.TableName === 'millwright-state',
    )!;
    expect(table.Properties.SSESpecification).toBeUndefined();
    expect(table.Properties.GlobalSecondaryIndexes).toBeUndefined();
  });

  it('survives stack deletion', () => {
    const { template } = templateFor();
    for (const table of Object.values(template.findResources('AWS::DynamoDB::Table'))) {
      expect(table.DeletionPolicy).toBe('Retain');
    }
  });
});

describe('polling table (C10)', () => {
  it('is on-demand with the same key shape, but no stream and no TTL', () => {
    const { template } = templateFor();
    const table = Object.values(template.findResources('AWS::DynamoDB::Table')).find(
      (t) => t.Properties.TableName === 'millwright-polling',
    )!;
    expect(table.Properties.BillingMode).toBe('PAY_PER_REQUEST');
    expect(table.Properties.StreamSpecification).toBeUndefined();
    expect(table.Properties.TimeToLiveSpecification).toBeUndefined();
  });
});

describe('artifact/cache bucket (C12)', () => {
  it('carries lifecycle rules for runs/, cache/ and incomplete uploads', () => {
    const { template } = templateFor();
    template.hasResourceProperties('AWS::S3::Bucket', {
      LifecycleConfiguration: {
        Rules: Match.arrayWith([
          Match.objectLike({ Prefix: 'runs/', ExpirationInDays: 90, Status: 'Enabled' }),
          Match.objectLike({ Prefix: 'cache/', ExpirationInDays: 14, Status: 'Enabled' }),
          Match.objectLike({
            AbortIncompleteMultipartUpload: { DaysAfterInitiation: 7 },
            Status: 'Enabled',
          }),
        ]),
      },
    });
  });

  it('expires runs/ per retention.artifacts, defaulting to retention.metadata', () => {
    const { template } = templateFor({ retention: { metadata: Duration.days(30) } });
    template.hasResourceProperties('AWS::S3::Bucket', {
      LifecycleConfiguration: {
        Rules: Match.arrayWith([Match.objectLike({ Prefix: 'runs/', ExpirationInDays: 30 })]),
      },
    });
    const { template: overridden } = templateFor({
      retention: { artifacts: Duration.days(7), cache: Duration.days(3) },
    });
    overridden.hasResourceProperties('AWS::S3::Bucket', {
      LifecycleConfiguration: {
        Rules: Match.arrayWith([
          Match.objectLike({ Prefix: 'runs/', ExpirationInDays: 7 }),
          Match.objectLike({ Prefix: 'cache/', ExpirationInDays: 3 }),
        ]),
      },
    });
  });

  it('blocks public access, enforces TLS, and uses S3-managed encryption', () => {
    const { template } = templateFor();
    template.hasResourceProperties('AWS::S3::Bucket', {
      PublicAccessBlockConfiguration: {
        BlockPublicAcls: true,
        BlockPublicPolicy: true,
        IgnorePublicAcls: true,
        RestrictPublicBuckets: true,
      },
      BucketEncryption: {
        ServerSideEncryptionConfiguration: [
          { ServerSideEncryptionByDefault: { SSEAlgorithm: 'AES256' } },
        ],
      },
    });
    template.hasResourceProperties('AWS::S3::BucketPolicy', {
      PolicyDocument: {
        Statement: Match.arrayWith([
          Match.objectLike({
            Effect: 'Deny',
            Condition: { Bool: { 'aws:SecureTransport': 'false' } },
          }),
        ]),
      },
    });
  });

  it('takes a deterministic namespaced name when it fits', () => {
    const { template } = templateFor();
    const [bucket] = Object.values(template.findResources('AWS::S3::Bucket'));
    expect(JSON.stringify(bucket.Properties.BucketName)).toContain('millwright-artifacts-');
  });

  it('falls back to an auto-generated name (with a warning) for long deployment names', () => {
    const longName = `a${'b'.repeat(30)}`;
    const { stack, template } = templateFor({ deploymentName: longName });
    const [bucket] = Object.values(template.findResources('AWS::S3::Bucket'));
    expect(bucket.Properties.BucketName).toBeUndefined();
    Annotations.fromStack(stack).hasWarning(
      '*',
      Match.stringLikeRegexp('too long for the deterministic bucket name'),
    );
  });
});

describe('config-plane CMK (C14)', () => {
  it('rotates and carries the deployment-scoped alias', () => {
    const { template } = templateFor();
    template.hasResourceProperties('AWS::KMS::Key', { EnableKeyRotation: true });
    template.hasResourceProperties('AWS::KMS::Alias', {
      AliasName: 'alias/millwright/millwright',
    });
  });
});

describe('build log group (C17)', () => {
  it('creates /millwright/<name>/builds with 30-day default retention', () => {
    const { template } = templateFor();
    template.hasResourceProperties('AWS::Logs::LogGroup', {
      LogGroupName: '/millwright/millwright/builds',
      RetentionInDays: 30,
    });
  });

  it('honours a supported retention override', () => {
    const { template } = templateFor({ retention: { logs: Duration.days(7) } });
    template.hasResourceProperties('AWS::Logs::LogGroup', { RetentionInDays: 7 });
  });

  it('rejects retention day counts CloudWatch does not support', () => {
    const stack = new Stack(new App(), 'Test');
    expect(
      () =>
        new Millwright(stack, 'Millwright', {
          permissionsBoundary: BOUNDARY_ARN,
          retention: { logs: Duration.days(31) },
        }),
    ).toThrow(/supported day counts/);
  });
});

describe('deploymentName namespacing', () => {
  it('namespaces every store', () => {
    const { millwright, template } = templateFor({ deploymentName: 'ci-platform' });
    template.hasResourceProperties('AWS::DynamoDB::Table', { TableName: 'ci-platform-state' });
    template.hasResourceProperties('AWS::DynamoDB::Table', { TableName: 'ci-platform-polling' });
    template.hasResourceProperties('AWS::Logs::LogGroup', {
      LogGroupName: '/millwright/ci-platform/builds',
    });
    template.hasResourceProperties('AWS::KMS::Alias', {
      AliasName: 'alias/millwright/ci-platform',
    });
    const [bucket] = Object.values(template.findResources('AWS::S3::Bucket'));
    expect(JSON.stringify(bucket.Properties.BucketName)).toContain('ci-platform-artifacts-');
    expect(millwright.stateTable).toBeDefined();
    expect(millwright.pollingTable).toBeDefined();
    expect(millwright.artifactBucket).toBeDefined();
    expect(millwright.configKey).toBeDefined();
    expect(millwright.buildLogGroup).toBeDefined();
  });
});
