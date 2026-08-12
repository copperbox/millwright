import {
  CACHE_PREFIX,
  PARTITION_KEY_ATTRIBUTE,
  RUNS_PREFIX,
  SORT_KEY_ATTRIBUTE,
  TTL_ATTRIBUTE,
} from '@copperbox/millwright-state';
import { Annotations, Aws, Duration } from 'aws-cdk-lib';
import * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
import * as kms from 'aws-cdk-lib/aws-kms';
import * as logs from 'aws-cdk-lib/aws-logs';
import * as s3 from 'aws-cdk-lib/aws-s3';
import { Construct } from 'constructs';

export interface DataStoresProps {
  readonly deploymentName: string;
  /** CloudWatch retention for build logs; must be a CloudWatch-supported day count. */
  readonly logRetention: Duration;
  /** Lifecycle expiry for run artifacts and control-plane inputs (`runs/`). */
  readonly artifactRetention: Duration;
  /** Lifecycle expiry for keyed dependency caches (`cache/`). */
  readonly cacheRetention: Duration;
}

/**
 * Worst case of the artifact bucket's deterministic-name suffix,
 * `-artifacts-<account>-<region>`: 11 + 12 + 1 + 14 chars against S3's
 * 63-char cap. Longer deployment names fall back to an auto-generated name.
 */
const BUCKET_SUFFIX_BUDGET = '-artifacts-'.length + 12 + 1 + 14;

/**
 * The data stores of one millwright deployment (spec §9): the single-table
 * state store (C9), the polling table (C10), the artifact/cache bucket (C12),
 * the config-plane CMK (C14), and the build log group (C17). Everything is
 * namespaced by `deploymentName` so deployments can share an account+region.
 */
export class DataStores extends Construct {
  /** C9 — the CLI's source of truth. Never a credential store; not CMK-encrypted. */
  readonly stateTable: dynamodb.Table;
  /** Deterministic physical name of the state table: `<deploymentName>-state`. */
  readonly stateTableName: string;
  /** Deterministic physical name of the polling table: `<deploymentName>-polling`. */
  readonly pollingTableName: string;
  /** Deterministic physical name of the build log group: `/millwright/<name>/builds`. */
  readonly buildLogGroupName: string;
  /** C10 — poller-internal state; never queried by the CLI. */
  readonly pollingTable: dynamodb.Table;
  /** C12 — run artifacts, control-plane inputs, keyed dependency caches. */
  readonly artifactBucket: s3.Bucket;
  /** C14 — encrypts every SecureString in the SSM config plane. */
  readonly configKey: kms.Key;
  /** C14 — the key's stable, deploymentName-derived alias. */
  readonly configKeyAlias: string;
  /** C17 — one group; CodeBuild writes one stream per build. */
  readonly buildLogGroup: logs.LogGroup;

  constructor(scope: Construct, id: string, props: DataStoresProps) {
    super(scope, id);
    const name = props.deploymentName;

    // Encryption stays at the DynamoDB default (AWS-owned key), deliberately:
    // the state table is the most widely readable store in the system and is
    // never a credential store (spec §9.1) — gating it behind the CMK would
    // put kms:Decrypt in every reader's path for no secret worth protecting.
    this.stateTableName = `${name}-state`;
    this.pollingTableName = `${name}-polling`;
    this.buildLogGroupName = `/millwright/${name}/builds`;

    this.stateTable = new dynamodb.Table(this, 'StateTable', {
      tableName: this.stateTableName,
      partitionKey: { name: PARTITION_KEY_ATTRIBUTE, type: dynamodb.AttributeType.STRING },
      sortKey: { name: SORT_KEY_ATTRIBUTE, type: dynamodb.AttributeType.STRING },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      stream: dynamodb.StreamViewType.NEW_AND_OLD_IMAGES,
      // REG# rows are exempt by never carrying the attribute — enforced by
      // @copperbox/millwright-state's withMetadataTtl, not by the table.
      timeToLiveAttribute: TTL_ATTRIBUTE,
    });

    this.pollingTable = new dynamodb.Table(this, 'PollingTable', {
      tableName: this.pollingTableName,
      partitionKey: { name: PARTITION_KEY_ATTRIBUTE, type: dynamodb.AttributeType.STRING },
      sortKey: { name: SORT_KEY_ATTRIBUTE, type: dynamodb.AttributeType.STRING },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
    });

    this.configKeyAlias = `alias/millwright/${name}`;
    this.configKey = new kms.Key(this, 'ConfigKey', {
      alias: this.configKeyAlias,
      description:
        `millwright (${name}) config-plane key: SSM SecureStrings — workflow secrets, ` +
        'deploy keys, GitHub App PEM',
      enableKeyRotation: true,
    });

    const deterministicName = name.length + BUCKET_SUFFIX_BUDGET <= 63;
    if (!deterministicName) {
      Annotations.of(this).addWarningV2(
        '@copperbox/millwright-cdk:artifactBucketAutoNamed',
        `deploymentName "${name}" is too long for the deterministic bucket name ` +
          `"${name}-artifacts-<account>-<region>" (S3 caps names at 63 chars); ` +
          'letting CloudFormation name the bucket. The manifest still records the real name.',
      );
    }
    this.artifactBucket = new s3.Bucket(this, 'ArtifactBucket', {
      bucketName: deterministicName
        ? `${name}-artifacts-${Aws.ACCOUNT_ID}-${Aws.REGION}`
        : undefined,
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      enforceSSL: true,
      encryption: s3.BucketEncryption.S3_MANAGED,
      lifecycleRules: [
        {
          id: 'expire-run-artifacts',
          prefix: RUNS_PREFIX,
          expiration: props.artifactRetention,
        },
        {
          id: 'evict-dependency-caches',
          prefix: CACHE_PREFIX,
          expiration: props.cacheRetention,
        },
        {
          id: 'abort-incomplete-uploads',
          abortIncompleteMultipartUploadAfter: Duration.days(7),
        },
      ],
    });

    this.buildLogGroup = new logs.LogGroup(this, 'BuildLogGroup', {
      logGroupName: this.buildLogGroupName,
      retention: toRetentionDays(props.logRetention),
    });
  }
}

function toRetentionDays(retention: Duration): logs.RetentionDays {
  const days = retention.toDays();
  const supported = Object.values(logs.RetentionDays).filter(
    (value): value is logs.RetentionDays => typeof value === 'number',
  );
  if (!supported.includes(days)) {
    throw new Error(
      `retention.logs must be one of CloudWatch's supported day counts ` +
        `(${supported.sort((a, b) => a - b).join(', ')}), got ${days} days`,
    );
  }
  return days;
}
