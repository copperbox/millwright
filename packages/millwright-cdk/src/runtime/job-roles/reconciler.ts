import type { IAMClient, Tag } from '@aws-sdk/client-iam';
import {
  CreateRoleCommand,
  GetRoleCommand,
  PutRolePolicyCommand,
  TagRoleCommand,
  UntagRoleCommand,
} from '@aws-sdk/client-iam';
import {
  JOB_ROLE_INLINE_POLICY_NAME,
  JOB_ROLE_TAG_KEYS,
  JobRoleIdentity,
  JobRolePolicyContext,
  JobRoleSecretGrants,
  JobRoleVariant,
  PolicyDocument,
  fullPolicyDocument,
  jobRoleName,
  jobRolePath,
  jobRolePolicyHash,
  jobRoleTags,
  jobRoleTrustPolicy,
  noSecretPolicyDocument,
  refReceivesSecrets,
} from '@copperbox/millwright-state';

/**
 * Idempotent reconciliation of the stable job-role pair (spec §10.2), shared
 * by the post-synth step (which materializes both variants on the first
 * trusted synth) and the decider (which verifies the stored policy hash at
 * dispatch and updates on mismatch).
 *
 * Trust rules are structural here, not caller discipline:
 *
 * - `ensureNoSecretRole` cannot accept model-derived grants — its policy is a
 *   pure function of deployment context and operator repo config.
 * - `ensureFullRole` re-checks the run's ref against `secretsAllowedRefs`
 *   and throws `UntrustedRefError` before any IAM write, so an untrusted-ref
 *   synth can never mutate any role even if a caller forgets the gate.
 *
 * Every CreateRole carries the deployment's permissions boundary; the
 * decider's own `iam:` grants deny the call without it (job-role-guards.ts).
 */

/** A caller passed an untrusted ref where full-grants reconciliation was asked. */
export class UntrustedRefError extends Error {
  constructor(ref: string) {
    super(
      `Ref "${ref}" does not match secretsAllowedRefs: the full-grants variant is only ever ` +
        'created or updated from validated models of allowlisted refs',
    );
    this.name = 'UntrustedRefError';
  }
}

export interface JobRoleReconcilerConfig {
  readonly deploymentName: string;
  /** The deployment's boundary ARN; undefined only under `Boundary.NONE`. */
  readonly permissionsBoundaryArn?: string;
  /** Deployment-level policy context; per-repo pieces arrive per call. */
  readonly policyContext: Omit<JobRolePolicyContext, 'ecrPullRepoArns'>;
}

/** The (repo, workflow, job) a role pair belongs to, plus its repo config gates. */
export interface JobRoleScope {
  readonly repo: string;
  readonly workflow: string;
  readonly job: string;
  /** Repo config's `ecrPullRepos` allowlist as repository ARNs. */
  readonly ecrPullRepoArns?: readonly string[];
}

export type JobRoleOutcome = 'created' | 'updated' | 'unchanged';

export interface EnsuredJobRole {
  readonly roleName: string;
  readonly roleArn: string;
  readonly policyHash: string;
  readonly outcome: JobRoleOutcome;
}

function errorName(error: unknown): string {
  return error instanceof Error ? error.name : '';
}

export class JobRoleReconciler {
  constructor(
    private readonly client: IAMClient,
    private readonly config: JobRoleReconcilerConfig,
  ) {}

  /**
   * Ensure the no-secret-grants variant. Safe to call from ANY run's dispatch
   * path — untrusted refs included — because nothing about it derives from a
   * model: an untrusted synth's output cannot reach this policy.
   */
  async ensureNoSecretRole(scope: JobRoleScope): Promise<EnsuredJobRole> {
    const identity = this.identityOf(scope);
    const policy = noSecretPolicyDocument(identity, {
      ...this.config.policyContext,
      ecrPullRepoArns: scope.ecrPullRepoArns,
    });
    return this.reconcile(identity, 'no-secret', policy);
  }

  /**
   * Ensure the full-grants variant from a validated model's declared secrets.
   * Throws `UntrustedRefError` unless the run's ref matches the repo's
   * `secretsAllowedRefs` — the same gate the decider's variant selection uses.
   */
  async ensureFullRole(
    scope: JobRoleScope,
    run: { readonly ref: string; readonly secretsAllowedRefs: readonly string[] | undefined },
    grants: JobRoleSecretGrants,
  ): Promise<EnsuredJobRole> {
    if (!refReceivesSecrets(run.ref, run.secretsAllowedRefs)) {
      throw new UntrustedRefError(run.ref);
    }
    const identity = this.identityOf(scope);
    const policy = fullPolicyDocument(
      identity,
      { ...this.config.policyContext, ecrPullRepoArns: scope.ecrPullRepoArns },
      grants,
    );
    return this.reconcile(identity, 'full', policy);
  }

  private identityOf(scope: JobRoleScope): JobRoleIdentity {
    return {
      deploymentName: this.config.deploymentName,
      repo: scope.repo,
      workflow: scope.workflow,
      job: scope.job,
    };
  }

  private async reconcile(
    identity: JobRoleIdentity,
    variant: JobRoleVariant,
    policy: PolicyDocument,
  ): Promise<EnsuredJobRole> {
    const roleName = jobRoleName(identity, variant);
    const policyHash = jobRolePolicyHash(policy);

    let existing: { arn: string; tags: Tag[] } | undefined;
    try {
      const found = await this.client.send(new GetRoleCommand({ RoleName: roleName }));
      existing = { arn: found.Role?.Arn ?? '', tags: found.Role?.Tags ?? [] };
    } catch (error) {
      if (errorName(error) !== 'NoSuchEntityException') {
        throw error;
      }
    }

    if (!existing) {
      const arn = await this.create(identity, variant, roleName, policyHash);
      if (arn !== undefined) {
        await this.putPolicy(roleName, policy);
        return { roleName, roleArn: arn, policyHash, outcome: 'created' };
      }
      // Lost a create race: re-read and fall through to the update path.
      const found = await this.client.send(new GetRoleCommand({ RoleName: roleName }));
      existing = { arn: found.Role?.Arn ?? '', tags: found.Role?.Tags ?? [] };
    }

    const storedHash = existing.tags.find(
      (tag) => tag.Key === JOB_ROLE_TAG_KEYS.policyHash,
    )?.Value;
    const orphaned = existing.tags.some((tag) => tag.Key === JOB_ROLE_TAG_KEYS.orphanedAt);
    if (orphaned) {
      // Being reconciled means being live again; clear the sweep's marker.
      await this.client.send(
        new UntagRoleCommand({ RoleName: roleName, TagKeys: [JOB_ROLE_TAG_KEYS.orphanedAt] }),
      );
    }
    if (storedHash === policyHash) {
      return { roleName, roleArn: existing.arn, policyHash, outcome: 'unchanged' };
    }

    await this.putPolicy(roleName, policy);
    await this.client.send(
      new TagRoleCommand({
        RoleName: roleName,
        Tags: [{ Key: JOB_ROLE_TAG_KEYS.policyHash, Value: policyHash }],
      }),
    );
    return { roleName, roleArn: existing.arn, policyHash, outcome: 'updated' };
  }

  /** Role ARN, or undefined when another writer created the role first. */
  private async create(
    identity: JobRoleIdentity,
    variant: JobRoleVariant,
    roleName: string,
    policyHash: string,
  ): Promise<string | undefined> {
    try {
      const created = await this.client.send(
        new CreateRoleCommand({
          RoleName: roleName,
          Path: jobRolePath(identity.deploymentName),
          AssumeRolePolicyDocument: JSON.stringify(
            jobRoleTrustPolicy(this.config.policyContext.accountId),
          ),
          PermissionsBoundary: this.config.permissionsBoundaryArn,
          Description:
            `millwright (${identity.deploymentName}) ${variant} job role: ` +
            `${identity.repo} / ${identity.workflow} / ${identity.job}`,
          Tags: [
            ...jobRoleTags(identity, variant),
            { Key: JOB_ROLE_TAG_KEYS.policyHash, Value: policyHash },
          ],
        }),
      );
      return created.Role?.Arn ?? '';
    } catch (error) {
      if (errorName(error) === 'EntityAlreadyExistsException') {
        return undefined;
      }
      throw error;
    }
  }

  private async putPolicy(roleName: string, policy: PolicyDocument): Promise<void> {
    await this.client.send(
      new PutRolePolicyCommand({
        RoleName: roleName,
        PolicyName: JOB_ROLE_INLINE_POLICY_NAME,
        PolicyDocument: JSON.stringify(policy),
      }),
    );
  }
}
