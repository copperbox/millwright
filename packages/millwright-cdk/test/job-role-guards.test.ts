import { describe, expect, it } from 'vitest';
import {
  jobRoleArnPattern,
  jobRolePassStatement,
  jobRoleReconciliationStatements,
  jobRoleSweepStatements,
} from '../src';

const BOUNDARY_ARN = 'arn:aws:iam::123456789012:policy/team-boundary';
const PROPS = {
  deploymentName: 'millwright',
  permissionsBoundaryArn: BOUNDARY_ARN,
  account: '123456789012',
  partition: 'aws',
};
const PATTERN = 'arn:aws:iam::123456789012:role/millwright/millwright/jobs/mw-*';

describe('jobRoleArnPattern', () => {
  it('covers exactly the deployment path and the mw-* namespace', () => {
    expect(jobRoleArnPattern(PROPS)).toBe(PATTERN);
  });

  it('defaults account and partition to stack pseudo-parameters', () => {
    const pattern = jobRoleArnPattern({ deploymentName: 'millwright' });
    expect(pattern).toContain(':role/millwright/millwright/jobs/mw-*');
  });
});

describe('jobRoleReconciliationStatements', () => {
  const [guarded, metadata] = jobRoleReconciliationStatements(PROPS).map((statement) =>
    statement.toStatementJson(),
  );

  it('pins CreateRole/PutRolePolicy to the permissions boundary', () => {
    expect(guarded).toEqual({
      Sid: 'GuardedJobRoleWrites',
      Effect: 'Allow',
      Action: ['iam:CreateRole', 'iam:PutRolePolicy'],
      Resource: PATTERN,
      Condition: { StringEquals: { 'iam:PermissionsBoundary': BOUNDARY_ARN } },
    });
  });

  it('leaves tag/read operations unconditioned but namespace-scoped', () => {
    expect(metadata).toEqual({
      Sid: 'JobRoleMetadata',
      Effect: 'Allow',
      Action: ['iam:GetRole', 'iam:ListRoleTags', 'iam:TagRole', 'iam:UntagRole'],
      Resource: PATTERN,
    });
  });

  it('drops the boundary condition only under Boundary.NONE', () => {
    const [unguarded] = jobRoleReconciliationStatements({
      ...PROPS,
      permissionsBoundaryArn: undefined,
    }).map((statement) => statement.toStatementJson());
    expect(unguarded.Condition).toBeUndefined();
    expect(unguarded.Resource).toBe(PATTERN);
  });
});

describe('jobRolePassStatement', () => {
  it('scopes PassRole to the namespace and pins the passed-to service', () => {
    expect(jobRolePassStatement(PROPS).toStatementJson()).toEqual({
      Sid: 'PassJobRolesToCodeBuild',
      Effect: 'Allow',
      Action: 'iam:PassRole',
      Resource: PATTERN,
      Condition: { StringEquals: { 'iam:PassedToService': 'codebuild.amazonaws.com' } },
    });
  });
});

describe('jobRoleSweepStatements', () => {
  const statements = jobRoleSweepStatements(PROPS).map((statement) =>
    statement.toStatementJson(),
  );

  it('can enumerate, mark, and delete — but never create or grant', () => {
    const actions = statements.flatMap((statement) => statement.Action);
    expect(actions).toContain('iam:ListRoles');
    expect(actions).toContain('iam:DeleteRole');
    expect(actions).toContain('iam:DeleteRolePolicy');
    expect(actions).not.toContain('iam:CreateRole');
    expect(actions).not.toContain('iam:PutRolePolicy');
    expect(actions).not.toContain('iam:PassRole');
  });

  it('scopes everything but ListRoles to the namespace', () => {
    for (const statement of statements) {
      if (statement.Action === 'iam:ListRoles' || statement.Action?.includes?.('iam:ListRoles')) {
        expect(statement.Resource).toBe('*');
      } else {
        expect(statement.Resource).toBe(PATTERN);
      }
    }
  });
});
