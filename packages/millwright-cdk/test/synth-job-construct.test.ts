import { App, Stack } from 'aws-cdk-lib';
import { Match, Template } from 'aws-cdk-lib/assertions';
import { beforeAll, describe, expect, it } from 'vitest';
import { Millwright } from '../src/millwright';
import { SYNTH_IMAGE } from '../src/synth-image';

const BOUNDARY_ARN = 'arn:aws:iam::123456789012:policy/boundary';

let millwright: Millwright;
let template: Template;

beforeAll(() => {
  const app = new App();
  const stack = new Stack(app, 'Test');
  millwright = new Millwright(stack, 'Millwright', { permissionsBoundary: BOUNDARY_ARN });
  template = Template.fromStack(stack);
}, 120_000);

/** All policy statements attached to the role with the given logical id. */
function statementsOf(roleLogicalId: string): { Action: unknown; Resource?: unknown }[] {
  const json = template.toJSON() as {
    Resources: Record<string, { Type: string; Properties: Record<string, unknown> }>;
  };
  const statements: { Action: unknown; Resource?: unknown }[] = [];
  for (const resource of Object.values(json.Resources)) {
    if (resource.Type !== 'AWS::IAM::Policy') {
      continue;
    }
    const roles = (resource.Properties.Roles ?? []) as { Ref?: string }[];
    if (!roles.some((role) => role.Ref === roleLogicalId)) {
      continue;
    }
    const document = resource.Properties.PolicyDocument as {
      Statement: { Action: unknown; Resource?: unknown }[];
    };
    statements.push(...document.Statement);
  }
  return statements;
}

function actionsOf(roleLogicalId: string): string[] {
  return statementsOf(roleLogicalId).flatMap((statement) =>
    Array.isArray(statement.Action) ? (statement.Action as string[]) : [String(statement.Action)],
  );
}

function logicalIdOf(construct: { node: { defaultChild?: unknown } }): string {
  const stack = Stack.of(millwright);
  return stack.resolve(
    (construct.node.defaultChild as { ref?: string; attrArn?: string; logicalId: string })
      .logicalId,
  ) as string;
}

describe('C11 — the single CodeBuild project', () => {
  it('deploys under the exact name the run executor pinned', () => {
    expect(millwright.synthJob.buildProjectName).toBe('millwright-builds');
    template.hasResourceProperties('AWS::CodeBuild::Project', {
      Name: 'millwright-builds',
      Environment: Match.objectLike({ Type: 'ARM_CONTAINER', ComputeType: 'BUILD_GENERAL1_SMALL' }),
    });
  });

  it('streams build logs into the C17 log group', () => {
    template.hasResourceProperties('AWS::CodeBuild::Project', {
      Name: 'millwright-builds',
      LogsConfig: Match.objectLike({
        CloudWatchLogs: Match.objectLike({ Status: 'ENABLED' }),
      }),
    });
  });
});

describe('the synth phase Lambdas carry the pinned names', () => {
  it('deploys <name>-synth and <name>-post-synth', () => {
    expect(millwright.synthJob.synthFunctionName).toBe('millwright-synth');
    expect(millwright.synthJob.postSynthFunctionName).toBe('millwright-post-synth');
    template.hasResourceProperties('AWS::Lambda::Function', {
      FunctionName: 'millwright-synth',
    });
    template.hasResourceProperties('AWS::Lambda::Function', {
      FunctionName: 'millwright-post-synth',
    });
  });

  it('hands the synth Lambda the full build-start configuration', () => {
    template.hasResourceProperties('AWS::Lambda::Function', {
      FunctionName: 'millwright-synth',
      Environment: {
        Variables: Match.objectLike({
          DEPLOYMENT_NAME: 'millwright',
          BUILD_PROJECT_NAME: 'millwright-builds',
          SCHEMA_CEILING: '1',
          POLL_CADENCE_MINUTES: '1',
          SYNTH_TOOLS_KEY: Match.anyValue(),
        }),
      },
    });
  });
});

describe('the synth job role (spec §10.3)', () => {
  it('is assumable only by CodeBuild', () => {
    template.hasResourceProperties('AWS::IAM::Role', {
      RoleName: 'millwright-synth-job',
      AssumeRolePolicyDocument: Match.objectLike({
        Statement: [
          Match.objectLike({
            Principal: { Service: 'codebuild.amazonaws.com' },
          }),
        ],
      }),
    });
  });

  it('reads deploy keys, host-key pins and repo config; decrypts under the CMK', () => {
    const actions = actionsOf(logicalIdOf(millwright.synthJob.synthJobRole));
    expect(actions).toContain('ssm:GetParameters');
    expect(actions).toContain('kms:Decrypt');
  });

  it('writes ONLY in/ subprefixes of the runs/ tree', () => {
    const statements = statementsOf(logicalIdOf(millwright.synthJob.synthJobRole));
    const puts = statements.filter((statement) => {
      const actions = Array.isArray(statement.Action) ? statement.Action : [statement.Action];
      return (actions as string[]).some((action) => action === 's3:PutObject');
    });
    expect(puts).toHaveLength(1);
    const resource = JSON.stringify(puts[0].Resource);
    expect(resource).toContain('runs/*/in/*');
  });

  it('has NO DynamoDB access — the registry-overwrite vector is closed at the root', () => {
    const actions = actionsOf(logicalIdOf(millwright.synthJob.synthJobRole));
    expect(actions.filter((action) => action.startsWith('dynamodb:'))).toEqual([]);
  });
});

describe('the synth Lambda role', () => {
  it('starts builds and passes exactly the synth job role, only to CodeBuild', () => {
    template.hasResourceProperties('AWS::IAM::Policy', {
      PolicyDocument: Match.objectLike({
        Statement: Match.arrayWith([
          Match.objectLike({
            Action: 'iam:PassRole',
            Condition: {
              StringEquals: { 'iam:PassedToService': 'codebuild.amazonaws.com' },
            },
          }),
        ]),
      }),
    });
  });

  it('has no DynamoDB access either — only post-synth writes the table', () => {
    const synthRole = millwright.synthJob.synthFn.role!;
    const actions = actionsOf(logicalIdOf(synthRole as unknown as { node: { defaultChild?: unknown } }));
    expect(actions.filter((action) => action.startsWith('dynamodb:'))).toEqual([]);
  });
});

describe('the synth-events completer', () => {
  it('watches terminal build states of exactly this deployment project', () => {
    template.hasResourceProperties('AWS::Events::Rule', {
      EventPattern: {
        source: ['aws.codebuild'],
        'detail-type': ['CodeBuild Build State Change'],
        detail: {
          'project-name': ['millwright-builds'],
          'build-status': ['SUCCEEDED', 'FAILED', 'FAULT', 'TIMED_OUT', 'STOPPED'],
        },
      },
    });
  });

  it('may complete task tokens on the pinned run-executor machine', () => {
    const completerRole = millwright.synthJob.synthEventsFn.role!;
    const statements = statementsOf(
      logicalIdOf(completerRole as unknown as { node: { defaultChild?: unknown } }),
    );
    const tokenStatement = statements.find((statement) => {
      const actions = Array.isArray(statement.Action) ? statement.Action : [statement.Action];
      return (actions as string[]).includes('states:SendTaskSuccess');
    });
    expect(tokenStatement).toBeDefined();
    expect(JSON.stringify(tokenStatement!.Resource)).toContain(
      'stateMachine:millwright-run-executor',
    );
  });
});

describe('the pinned image and tooling asset (C13)', () => {
  it('exposes the digest-pinned synth image and a staged tooling bundle', () => {
    expect(SYNTH_IMAGE).toContain('@sha256:');
    expect(millwright.synthJob.toolsAsset.s3ObjectKey).toMatch(/\.zip$/);
  });
});
