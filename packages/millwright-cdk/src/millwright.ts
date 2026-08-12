import { manifestParameterName } from '@copperbox/millwright-state';
import { Annotations, Duration } from 'aws-cdk-lib';
import * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as kms from 'aws-cdk-lib/aws-kms';
import * as logs from 'aws-cdk-lib/aws-logs';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as ssm from 'aws-cdk-lib/aws-ssm';
import { Construct } from 'constructs';
import { Boundary } from './boundary';
import { DataStores } from './data-stores';
import { MillwrightEventBus } from './event-bus';
import { Launcher } from './launcher';
import { Poller } from './poller';
import { SUPPORTED_SCHEMA_VERSION, VERSION } from './version';

const DEPLOYMENT_NAME_PATTERN = /^[a-z][a-z0-9-]{0,62}$/;

export interface RetentionProps {
  /** CloudWatch log retention. @default Duration.days(30) */
  readonly logs?: Duration;
  /** Run/job metadata retention (state table TTL). @default Duration.days(90) */
  readonly metadata?: Duration;
  /**
   * Run artifact retention: lifecycle expiry on the bucket's `runs/` prefix.
   * @default the metadata retention — artifacts age out with their run rows
   */
  readonly artifacts?: Duration;
  /**
   * Dependency-cache retention: lifecycle expiry on the bucket's `cache/`
   * prefix. @default Duration.days(14)
   */
  readonly cache?: Duration;
}

export interface MillwrightProps {
  /**
   * IAM permissions boundary ARN applied to every role millwright creates,
   * including the job roles that repo-editable workflow definitions shape.
   *
   * REQUIRED: this is the only cap on what watched-repo code can request, so
   * the construct throws at construct time when it is absent — the failure
   * surfaces as a `cdk synth` error on the operator's machine. The only
   * opt-out is the explicit `Boundary.NONE` sentinel, which emits a
   * synth-time warning instead.
   */
  readonly permissionsBoundary: string | Boundary;

  /**
   * Namespaces the SSM config plane (`/millwright/<name>/…`) and resource
   * names, so several deployments can share an account+region.
   * @default 'millwright'
   */
  readonly deploymentName?: string;

  /** Poll tick cadence. @default Duration.minutes(1) */
  readonly pollCadence?: Duration;

  /** Log and metadata retention. @default 30 days logs, 90 days metadata */
  readonly retention?: RetentionProps;
}

/**
 * The millwright control plane: polling-driven CI/CD in your own AWS account.
 *
 * Instantiate once per deployment, either in your own CDK app or in the thin
 * two-file app `millwright init` scaffolds. Upgrades are npm version bumps
 * plus `cdk deploy` — never a git merge of a cloned template.
 */
export class Millwright extends Construct {
  /** Deployment name namespacing SSM paths and resources. */
  readonly deploymentName: string;
  /** Permissions boundary ARN, or undefined when Boundary.NONE was passed. */
  readonly permissionsBoundaryArn?: string;
  /** Effective poll cadence. */
  readonly pollCadence: Duration;
  /** Effective log retention. */
  readonly logRetention: Duration;
  /** Effective metadata retention. */
  readonly metadataRetention: Duration;
  /** Effective run-artifact retention. */
  readonly artifactRetention: Duration;
  /** Effective dependency-cache retention. */
  readonly cacheRetention: Duration;
  /** C9 — the single-table state store (Streams enabled, TTL on `expiresAt`). */
  readonly stateTable: dynamodb.Table;
  /** C10 — the polling table. */
  readonly pollingTable: dynamodb.Table;
  /** C12 — the artifact/cache bucket. */
  readonly artifactBucket: s3.Bucket;
  /** C14 — the CMK under which every config-plane SecureString is encrypted. */
  readonly configKey: kms.Key;
  /** C17 — the log group receiving one stream per build. */
  readonly buildLogGroup: logs.LogGroup;
  /** C3 — the event bus with its source-conditioned resource policy. */
  readonly eventBus: MillwrightEventBus;
  /** C4 — the launcher consuming trigger events from the bus. */
  readonly launcher: Launcher;
  /** C2 — the tier-1 SSH ls-refs poller and its tick schedule. */
  readonly poller: Poller;
  /** SSM name of the self-registered deployment manifest — the CLI's discovery root. */
  readonly manifestParameterName: string;
  /** The deployment manifest parameter. */
  readonly manifestParameter: ssm.StringParameter;

  constructor(scope: Construct, id: string, props: MillwrightProps) {
    super(scope, id);

    const boundary = props?.permissionsBoundary;
    if (boundary === undefined || boundary === null) {
      throw new Error(
        'Millwright requires a permissions boundary: it is the only cap on the IAM that ' +
          'repo-editable workflow definitions can request. Pass permissionsBoundary: ' +
          '"<managed policy ARN>", or opt out explicitly with permissionsBoundary: Boundary.NONE.',
      );
    }

    if (boundary instanceof Boundary) {
      Annotations.of(this).addWarningV2(
        '@copperbox/millwright-cdk:noPermissionsBoundary',
        'Boundary.NONE: this deployment has no permissions boundary. Job roles requested by ' +
          'watched-repo workflow definitions are capped only by control-plane policy. Prefer ' +
          'permissionsBoundary: "<managed policy ARN>".',
      );
    } else if (typeof boundary === 'string') {
      if (!boundary.startsWith('arn:')) {
        throw new Error(
          `permissionsBoundary must be a managed policy ARN or Boundary.NONE, got "${boundary}"`,
        );
      }
      this.permissionsBoundaryArn = boundary;
      iam.PermissionsBoundary.of(this).apply(
        iam.ManagedPolicy.fromManagedPolicyArn(this, 'PermissionsBoundary', boundary),
      );
    } else {
      throw new Error('permissionsBoundary must be a managed policy ARN string or Boundary.NONE');
    }

    this.deploymentName = props.deploymentName ?? 'millwright';
    if (!DEPLOYMENT_NAME_PATTERN.test(this.deploymentName)) {
      throw new Error(
        `Invalid deploymentName "${this.deploymentName}": must start with a lowercase letter ` +
          'and contain only lowercase letters, digits and "-" (max 63 chars)',
      );
    }

    this.pollCadence = props.pollCadence ?? Duration.minutes(1);
    this.logRetention = props.retention?.logs ?? Duration.days(30);
    this.metadataRetention = props.retention?.metadata ?? Duration.days(90);
    this.artifactRetention = props.retention?.artifacts ?? this.metadataRetention;
    this.cacheRetention = props.retention?.cache ?? Duration.days(14);

    const stores = new DataStores(this, 'DataStores', {
      deploymentName: this.deploymentName,
      logRetention: this.logRetention,
      artifactRetention: this.artifactRetention,
      cacheRetention: this.cacheRetention,
    });
    this.stateTable = stores.stateTable;
    this.pollingTable = stores.pollingTable;
    this.artifactBucket = stores.artifactBucket;
    this.configKey = stores.configKey;
    this.buildLogGroup = stores.buildLogGroup;

    this.eventBus = new MillwrightEventBus(this, 'EventBus', {
      deploymentName: this.deploymentName,
    });
    this.launcher = new Launcher(this, 'Launcher', {
      deploymentName: this.deploymentName,
      bus: this.eventBus.bus,
      stateTable: this.stateTable,
      artifactBucket: this.artifactBucket,
      metadataRetention: this.metadataRetention,
    });
    this.poller = new Poller(this, 'Poller', {
      deploymentName: this.deploymentName,
      pollCadence: this.pollCadence,
      pollingTable: this.pollingTable,
      stateTable: this.stateTable,
      busName: this.eventBus.busName,
      pollerRoleName: this.eventBus.pollerRoleName,
      configKey: this.configKey,
    });

    // Self-registered deployment manifest: the CLI lists /millwright/*/manifest
    // and auto-picks when exactly one deployment exists in the account+region.
    // Physical resource names ride along so no consumer ever reconstructs them.
    this.manifestParameterName = manifestParameterName(this.deploymentName);
    this.manifestParameter = new ssm.StringParameter(this, 'Manifest', {
      parameterName: this.manifestParameterName,
      description: `millwright deployment manifest (${this.deploymentName})`,
      stringValue: JSON.stringify({
        deploymentName: this.deploymentName,
        version: VERSION,
        schemaVersion: SUPPORTED_SCHEMA_VERSION,
        pollCadenceSeconds: this.pollCadence.toSeconds(),
        retention: {
          logDays: this.logRetention.toDays(),
          metadataDays: this.metadataRetention.toDays(),
          artifactDays: this.artifactRetention.toDays(),
          cacheDays: this.cacheRetention.toDays(),
        },
        permissionsBoundary: this.permissionsBoundaryArn ?? null,
        resources: {
          stateTable: stores.stateTableName,
          pollingTable: stores.pollingTableName,
          artifactBucket: this.artifactBucket.bucketName,
          buildLogGroup: stores.buildLogGroupName,
          configKeyArn: this.configKey.keyArn,
          configKeyAlias: stores.configKeyAlias,
          // The CLI's dispatch/bootstrap PutEvents target.
          eventBus: this.eventBus.busName,
        },
      }),
    });
  }
}
