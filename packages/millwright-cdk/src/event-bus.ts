import {
  CLI_EVENT_SOURCE,
  POLLER_EVENT_SOURCE,
  STEP_EVENT_SOURCE,
} from '@copperbox/millwright-state';
import { Aws } from 'aws-cdk-lib';
import * as events from 'aws-cdk-lib/aws-events';
import { Construct } from 'constructs';

export interface MillwrightEventBusProps {
  readonly deploymentName: string;
}

/**
 * C3 — the deployment's event bus, carrying `push` / `branch` / `tag` / `pr`
 * / `cron` / `dispatch` / `bootstrap` / `rerun` events plus `millwright.step`
 * step events (spec §7.1).
 *
 * The resource policy binds every source to its one legitimate emitter using
 * the documented `events:source` condition key, as explicit Denies so
 * identity policies can never widen them:
 *
 * - `millwright.poller` — only the poller role (`<deploymentName>-poller`)
 * - `millwright.step`   — only per-run job roles (`<deploymentName>-job-*`)
 * - `millwright.cli`    — any principal EXCEPT those system roles; operator
 *   CLI principals get PutEvents from their own identity policies
 * - anything else       — denied outright
 *
 * A forged push therefore requires the poller role's own credentials. The
 * poller and job-role names are pinned HERE, ahead of the consists that
 * create those roles — they must use these exact names for the bindings to
 * hold.
 */
export class MillwrightEventBus extends Construct {
  readonly bus: events.EventBus;
  /** Deterministic bus name, `<deploymentName>-bus` — recorded in the manifest. */
  readonly busName: string;
  /** Pinned name of the poller Lambda's role: `<deploymentName>-poller`. */
  readonly pollerRoleName: string;
  /** Pinned name prefix of per-run job roles: `<deploymentName>-job-`. */
  readonly jobRoleNamePrefix: string;

  constructor(scope: Construct, id: string, props: MillwrightEventBusProps) {
    super(scope, id);
    const name = props.deploymentName;
    this.busName = `${name}-bus`;
    this.pollerRoleName = `${name}-poller`;
    this.jobRoleNamePrefix = `${name}-job-`;

    this.bus = new events.EventBus(this, 'Bus', { eventBusName: this.busName });

    // The bus ARN is spelled out from the deterministic name: referencing the
    // bus's own Arn attribute inside its own Policy property would be a
    // CloudFormation self-reference.
    const busArn = `arn:${Aws.PARTITION}:events:${Aws.REGION}:${Aws.ACCOUNT_ID}:event-bus/${this.busName}`;
    const pollerRoleArn = `arn:${Aws.PARTITION}:iam::${Aws.ACCOUNT_ID}:role/${this.pollerRoleName}`;
    const jobRoleArnPattern = `arn:${Aws.PARTITION}:iam::${Aws.ACCOUNT_ID}:role/${this.jobRoleNamePrefix}*`;

    const cfnBus = this.bus.node.defaultChild as events.CfnEventBus;
    cfnBus.policy = {
      Version: '2012-10-17',
      Statement: [
        {
          Sid: 'RequireMillwrightSources',
          Effect: 'Deny',
          Principal: '*',
          Action: 'events:PutEvents',
          Resource: busArn,
          Condition: {
            StringNotEquals: {
              'events:source': [POLLER_EVENT_SOURCE, CLI_EVENT_SOURCE, STEP_EVENT_SOURCE],
            },
          },
        },
        {
          Sid: 'PollerSourceRequiresPollerRole',
          Effect: 'Deny',
          Principal: '*',
          Action: 'events:PutEvents',
          Resource: busArn,
          Condition: {
            StringEquals: { 'events:source': POLLER_EVENT_SOURCE },
            StringNotLike: { 'aws:PrincipalArn': pollerRoleArn },
          },
        },
        {
          Sid: 'StepSourceRequiresJobRole',
          Effect: 'Deny',
          Principal: '*',
          Action: 'events:PutEvents',
          Resource: busArn,
          Condition: {
            StringEquals: { 'events:source': STEP_EVENT_SOURCE },
            StringNotLike: { 'aws:PrincipalArn': jobRoleArnPattern },
          },
        },
        {
          Sid: 'CliSourceForbidsSystemRoles',
          Effect: 'Deny',
          Principal: '*',
          Action: 'events:PutEvents',
          Resource: busArn,
          Condition: {
            StringEquals: { 'events:source': CLI_EVENT_SOURCE },
            StringLike: { 'aws:PrincipalArn': [pollerRoleArn, jobRoleArnPattern] },
          },
        },
      ],
    };
  }
}
