import { Annotations, Duration } from 'aws-cdk-lib';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as ssm from 'aws-cdk-lib/aws-ssm';
import { Construct } from 'constructs';
import { Boundary } from './boundary';
import { SUPPORTED_SCHEMA_VERSION, VERSION } from './version';

const DEPLOYMENT_NAME_PATTERN = /^[a-z][a-z0-9-]{0,62}$/;

export interface RetentionProps {
  /** CloudWatch log retention. @default Duration.days(30) */
  readonly logs?: Duration;
  /** Run/job metadata retention (state table TTL). @default Duration.days(90) */
  readonly metadata?: Duration;
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

    // Self-registered deployment manifest: the CLI lists /millwright/*/manifest
    // and auto-picks when exactly one deployment exists in the account+region.
    this.manifestParameterName = `/millwright/${this.deploymentName}/manifest`;
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
        },
        permissionsBoundary: this.permissionsBoundaryArn ?? null,
      }),
    });
  }
}
