import { JOB_ROLE_NAME_PREFIX, jobRolePath } from '@copperbox/millwright-state';
import { Aws } from 'aws-cdk-lib';
import * as iam from 'aws-cdk-lib/aws-iam';

/**
 * Escalation guards for job-role reconciliation (spec §10.3): the policy
 * statements attached to the two control-plane roles allowed to touch job
 * roles — the decider (create/update at dispatch, PassRole to CodeBuild) and
 * the sweep (stale-role housekeeping).
 *
 * The guards make a hostile `model.json` unable to mint or pass an unbounded
 * role even with the decider fully compromised:
 *
 * - `iam:CreateRole` / `iam:PutRolePolicy` carry an `iam:PermissionsBoundary`
 *   condition pinned to the deployment's boundary ARN — a CreateRole that
 *   omits the boundary, or a PutRolePolicy against a role not wearing it, is
 *   DENIED by IAM itself.
 * - `iam:PassRole` is scoped to the `mw-*` namespace under the deployment's
 *   job-role path, with `iam:PassedToService: codebuild.amazonaws.com`.
 *
 * Under `Boundary.NONE` there is no ARN to pin, so the boundary condition is
 * necessarily absent — the namespace scoping still holds, and the construct
 * already emits the synth-time warning that this posture is the operator's
 * explicit choice.
 */

export interface JobRoleGuardProps {
  readonly deploymentName: string;
  /** The deployment's boundary ARN; undefined only under `Boundary.NONE`. */
  readonly permissionsBoundaryArn?: string;
  /** @default Aws.ACCOUNT_ID */
  readonly account?: string;
  /** @default Aws.PARTITION */
  readonly partition?: string;
}

/**
 * ARN pattern covering exactly this deployment's job roles: the `mw-*` name
 * namespace under `/millwright/<deploymentName>/jobs/`.
 */
export function jobRoleArnPattern(props: JobRoleGuardProps): string {
  const partition = props.partition ?? Aws.PARTITION;
  const account = props.account ?? Aws.ACCOUNT_ID;
  return `arn:${partition}:iam::${account}:role${jobRolePath(
    props.deploymentName,
  )}${JOB_ROLE_NAME_PREFIX}*`;
}

/**
 * The decider's reconciliation grants (spec §10.3): boundary-conditioned
 * CreateRole/PutRolePolicy plus the unconditioned metadata operations
 * (reads and tag writes — powerless to escalate) on the same namespace.
 */
export function jobRoleReconciliationStatements(props: JobRoleGuardProps): iam.PolicyStatement[] {
  const pattern = jobRoleArnPattern(props);
  const guarded = new iam.PolicyStatement({
    sid: 'GuardedJobRoleWrites',
    actions: ['iam:CreateRole', 'iam:PutRolePolicy'],
    resources: [pattern],
  });
  if (props.permissionsBoundaryArn) {
    guarded.addCondition('StringEquals', {
      'iam:PermissionsBoundary': props.permissionsBoundaryArn,
    });
  }
  return [
    guarded,
    new iam.PolicyStatement({
      sid: 'JobRoleMetadata',
      actions: ['iam:GetRole', 'iam:ListRoleTags', 'iam:TagRole', 'iam:UntagRole'],
      resources: [pattern],
    }),
  ];
}

/** `iam:PassRole`, scoped to the namespace and pinned to CodeBuild. */
export function jobRolePassStatement(props: JobRoleGuardProps): iam.PolicyStatement {
  return new iam.PolicyStatement({
    sid: 'PassJobRolesToCodeBuild',
    actions: ['iam:PassRole'],
    resources: [jobRoleArnPattern(props)],
    conditions: {
      StringEquals: { 'iam:PassedToService': 'codebuild.amazonaws.com' },
    },
  });
}

/**
 * The sweep's housekeeping grants (spec §10.3): enumerate the deployment's
 * job-role path (`iam:ListRoles` takes no resource scoping — the PathPrefix
 * is the runtime filter), read/write orphan-marker tags, and delete stale
 * pairs. No CreateRole, no PutRolePolicy: the sweep can only ever remove.
 */
export function jobRoleSweepStatements(props: JobRoleGuardProps): iam.PolicyStatement[] {
  const pattern = jobRoleArnPattern(props);
  return [
    new iam.PolicyStatement({
      sid: 'ListJobRoles',
      actions: ['iam:ListRoles'],
      resources: ['*'],
    }),
    new iam.PolicyStatement({
      sid: 'JobRoleMetadata',
      actions: ['iam:GetRole', 'iam:ListRoleTags', 'iam:TagRole', 'iam:UntagRole'],
      resources: [pattern],
    }),
    new iam.PolicyStatement({
      sid: 'DeleteStaleJobRoles',
      actions: ['iam:DeleteRole', 'iam:DeleteRolePolicy'],
      resources: [pattern],
    }),
  ];
}
