import { createHash } from 'node:crypto';
import { JobRoleIdentity } from './job-roles';
import { KeyFormatError } from './keys';
import { CACHE_PREFIX, RUNS_PREFIX } from './s3-layout';

/**
 * Job-role policy documents (spec §10.2), built as plain JSON so the same
 * builders serve the post-synth step, the decider's dispatch-time reconcile,
 * and tests — no AWS SDK involved.
 *
 * The no-secret variant's document derives ONLY from deployment context and
 * the operator-written repo config (`ecrPullRepos`) — never from a model. The
 * full variant is the same baseline plus the model-declared secret grants,
 * and is only ever written from validated models of allowlisted refs.
 */

export interface PolicyStatement {
  readonly Sid?: string;
  readonly Effect: 'Allow' | 'Deny';
  readonly Action: readonly string[];
  /** Absent on trust-policy statements, whose target is the role itself. */
  readonly Resource?: readonly string[];
  readonly Condition?: Readonly<Record<string, Readonly<Record<string, string | string[]>>>>;
  readonly Principal?: Readonly<Record<string, string>>;
}

export interface PolicyDocument {
  readonly Version: '2012-10-17';
  readonly Statement: readonly PolicyStatement[];
}

/** Everything deployment- or repo-scoped a job-role policy references. */
export interface JobRolePolicyContext {
  /** @default 'aws' */
  readonly partition?: string;
  readonly region: string;
  readonly accountId: string;
  /** C12 — the artifact/cache bucket's name (not ARN). */
  readonly artifactBucketName: string;
  /** C3 — the bus `events:PutEvents` is conditioned on. */
  readonly eventBusArn: string;
  /** C17 — the group CodeBuild writes one stream per build into. */
  readonly buildLogGroupArn: string;
  /**
   * Repo config's `ecrPullRepos` allowlist as repository ARNs — operator
   * written, so admissible in the no-secret variant.
   */
  readonly ecrPullRepoArns?: readonly string[];
}

/** The full variant's model-derived additions (spec §10.2). */
export interface JobRoleSecretGrants {
  /** Declared workflow-secret SSM parameter ARNs. */
  readonly secretParameterArns: readonly string[];
  /** C14 — the CMK the SecureStrings sit under. */
  readonly configKeyArn: string;
  /** Declared Secrets Manager passthrough ARNs. */
  readonly passthroughSecretArns?: readonly string[];
}

/**
 * Trust policy shared by both variants: CodeBuild only, pinned to the
 * deployment's account so a build in someone else's account can never ride
 * the service principal in.
 */
export function jobRoleTrustPolicy(accountId: string): PolicyDocument {
  return {
    Version: '2012-10-17',
    Statement: [
      {
        Effect: 'Allow',
        Principal: { Service: 'codebuild.amazonaws.com' },
        Action: ['sts:AssumeRole'],
        Condition: { StringEquals: { 'aws:SourceAccount': accountId } },
      },
    ],
  };
}

const bucketArn = (partition: string, bucket: string) => `arn:${partition}:s3:::${bucket}`;

function sorted(values: readonly string[]): string[] {
  return [...new Set(values)].sort();
}

/**
 * The no-secret-grants document (spec §10.2) — nothing model-derived:
 *
 * - S3 read on `runs/<repo>/<wf>/*​/in/*` and run-wide artifact read (cross-run
 *   isolation within one workflow is an accepted, stated loss)
 * - S3 write on `runs/<repo>/<wf>/*​/out/<job>/*` only
 * - cache get/put on `cache/<repo>/*` with prefix-conditioned `s3:ListBucket`
 *   (repo-scoped cache-write trust is an accepted, stated loss)
 * - `events:PutEvents` conditioned to `source: millwright.step`
 * - build-log stream writes (C17 — CodeBuild fails the build without them)
 * - private-ECR pull on the repo config's `ecrPullRepos` allowlist
 * - NO DynamoDB access, and deploy keys carry an explicit Deny
 */
export function noSecretPolicyDocument(
  identity: JobRoleIdentity,
  context: JobRolePolicyContext,
): PolicyDocument {
  if (!identity.repo || !/^[^/]+\/[^/]+$/.test(identity.repo)) {
    throw new KeyFormatError(`repo must be "owner/name", got "${identity.repo}"`);
  }
  const partition = context.partition ?? 'aws';
  const bucket = bucketArn(partition, context.artifactBucketName);
  const workflowPrefix = `${RUNS_PREFIX}${identity.repo}/${identity.workflow}/*`;
  const cachePrefix = `${CACHE_PREFIX}${identity.repo}/*`;

  const statements: PolicyStatement[] = [
    {
      Sid: 'RunInputRead',
      Effect: 'Allow',
      Action: ['s3:GetObject'],
      Resource: [`${bucket}/${workflowPrefix}/in/*`],
    },
    {
      Sid: 'RunArtifactRead',
      Effect: 'Allow',
      Action: ['s3:GetObject'],
      Resource: [`${bucket}/${workflowPrefix}/out/*`],
    },
    {
      Sid: 'JobOutputWrite',
      Effect: 'Allow',
      Action: ['s3:PutObject'],
      Resource: [`${bucket}/${workflowPrefix}/out/${identity.job}/*`],
    },
    {
      Sid: 'CacheReadWrite',
      Effect: 'Allow',
      Action: ['s3:GetObject', 's3:PutObject'],
      Resource: [`${bucket}/${cachePrefix}`],
    },
    {
      Sid: 'CacheList',
      Effect: 'Allow',
      Action: ['s3:ListBucket'],
      Resource: [bucket],
      Condition: { StringLike: { 's3:prefix': [cachePrefix] } },
    },
    {
      Sid: 'StepEvents',
      Effect: 'Allow',
      Action: ['events:PutEvents'],
      Resource: [context.eventBusArn],
      Condition: { StringEquals: { 'events:source': 'millwright.step' } },
    },
    {
      Sid: 'BuildLogs',
      Effect: 'Allow',
      Action: ['logs:CreateLogStream', 'logs:PutLogEvents'],
      Resource: [context.buildLogGroupArn, `${context.buildLogGroupArn}:*`],
    },
  ];

  const ecrArns = sorted(context.ecrPullRepoArns ?? []);
  if (ecrArns.length > 0) {
    statements.push(
      {
        Sid: 'EcrAuth',
        Effect: 'Allow',
        Action: ['ecr:GetAuthorizationToken'],
        Resource: ['*'],
      },
      {
        Sid: 'EcrPull',
        Effect: 'Allow',
        Action: ['ecr:BatchCheckLayerAvailability', 'ecr:BatchGetImage', 'ecr:GetDownloadUrlForLayer'],
        Resource: ecrArns,
      },
    );
  }

  // The explicit negative grant of spec §10.2: no job role — either variant,
  // any deployment — can ever read a deploy key, whatever future Allows say.
  statements.push({
    Sid: 'DenyDeployKeys',
    Effect: 'Deny',
    Action: [
      'ssm:GetParameter',
      'ssm:GetParameterHistory',
      'ssm:GetParameters',
      'ssm:GetParametersByPath',
    ],
    Resource: [
      `arn:${partition}:ssm:${context.region}:${context.accountId}:parameter/millwright/*/repos/*/deploy-key`,
    ],
  });

  return { Version: '2012-10-17', Statement: statements };
}

/**
 * The full-grants document: the no-secret baseline PLUS (spec §10.2)
 *
 * - `ssm:GetParameters` (plural — CodeBuild's `env.parameter-store`
 *   resolution calls exactly this) on exactly the declared secret params
 * - `kms:Decrypt` on the CMK (the two-gate posture's second gate)
 * - `secretsmanager:GetSecretValue` on declared passthrough ARNs
 *
 * Callers MUST derive `grants` from a validated model of an allowlisted ref;
 * the reconciler enforces that with `refReceivesSecrets` before any write.
 */
export function fullPolicyDocument(
  identity: JobRoleIdentity,
  context: JobRolePolicyContext,
  grants: JobRoleSecretGrants,
): PolicyDocument {
  const base = noSecretPolicyDocument(identity, context);
  const statements = [...base.Statement];
  const insertAt = statements.findIndex((statement) => statement.Effect === 'Deny');
  const additions: PolicyStatement[] = [];
  const parameterArns = sorted(grants.secretParameterArns);
  if (parameterArns.length > 0) {
    additions.push(
      {
        Sid: 'SecretParameterRead',
        Effect: 'Allow',
        Action: ['ssm:GetParameters'],
        Resource: parameterArns,
      },
      {
        Sid: 'SecretDecrypt',
        Effect: 'Allow',
        Action: ['kms:Decrypt'],
        Resource: [grants.configKeyArn],
      },
    );
  }
  const passthroughArns = sorted(grants.passthroughSecretArns ?? []);
  if (passthroughArns.length > 0) {
    additions.push({
      Sid: 'PassthroughSecretRead',
      Effect: 'Allow',
      Action: ['secretsmanager:GetSecretValue'],
      Resource: passthroughArns,
    });
  }
  statements.splice(insertAt, 0, ...additions);
  return { Version: '2012-10-17', Statement: statements };
}

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(canonicalize);
  }
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
        .map(([key, entry]) => [key, canonicalize(entry)]),
    );
  }
  return value;
}

/**
 * Content hash of a policy document, stored as the role's
 * `millwright:policy-hash` tag and compared by the decider at dispatch
 * (spec §10.2). Key order is canonicalized so semantically identical
 * documents can never hash apart; statement/ARN order is significant and the
 * builders above emit it deterministically (sorted, deduplicated).
 */
export function jobRolePolicyHash(document: PolicyDocument): string {
  return createHash('sha256').update(JSON.stringify(canonicalize(document)), 'utf8').digest('hex');
}
