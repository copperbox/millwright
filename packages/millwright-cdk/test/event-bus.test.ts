import { App, Stack } from 'aws-cdk-lib';
import { Template } from 'aws-cdk-lib/assertions';
import { describe, expect, it } from 'vitest';
import { MillwrightEventBus } from '../src';

function synth(deploymentName = 'millwright'): {
  bus: MillwrightEventBus;
  template: Template;
} {
  const stack = new Stack(new App(), 'Test');
  const bus = new MillwrightEventBus(stack, 'EventBus', { deploymentName });
  return { bus, template: Template.fromStack(stack) };
}

describe('event bus (C3)', () => {
  it('creates the bus under its deterministic name and pins the emitter role names', () => {
    const { bus, template } = synth('ci');
    expect(bus.busName).toBe('ci-bus');
    expect(bus.pollerRoleName).toBe('ci-poller');
    expect(bus.jobRoleNamePrefix).toBe('ci-job-');
    template.hasResourceProperties('AWS::Events::EventBus', { Name: 'ci-bus' });
  });

  it('binds each source to its one legitimate emitter with explicit Denies', () => {
    const { template } = synth('ci');
    const [busResource] = Object.values(template.findResources('AWS::Events::EventBus'));
    const statements = busResource.Properties.Policy.Statement as Array<{
      Sid: string;
      Effect: string;
      Action: string;
      Condition: Record<string, Record<string, unknown>>;
    }>;
    expect(statements.map((s) => s.Sid)).toEqual([
      'RequireMillwrightSources',
      'PollerSourceRequiresPollerRole',
      'StepSourceRequiresJobRole',
      'CliSourceForbidsSystemRoles',
    ]);
    expect(statements.every((s) => s.Effect === 'Deny')).toBe(true);
    expect(statements.every((s) => s.Action === 'events:PutEvents')).toBe(true);

    const bySid = Object.fromEntries(statements.map((s) => [s.Sid, s]));
    expect(bySid.RequireMillwrightSources.Condition).toEqual({
      StringNotEquals: {
        'events:source': ['millwright.poller', 'millwright.cli', 'millwright.step'],
      },
    });
    expect(bySid.PollerSourceRequiresPollerRole.Condition.StringEquals).toEqual({
      'events:source': 'millwright.poller',
    });
    expect(
      JSON.stringify(bySid.PollerSourceRequiresPollerRole.Condition.StringNotLike),
    ).toContain(':role/ci-poller');
    expect(bySid.StepSourceRequiresJobRole.Condition.StringEquals).toEqual({
      'events:source': 'millwright.step',
    });
    expect(JSON.stringify(bySid.StepSourceRequiresJobRole.Condition.StringNotLike)).toContain(
      ':role/ci-job-*',
    );
    // System roles can never emit CLI-sourced events; operators are limited
    // to millwright.cli by the poller/step statements above.
    expect(bySid.CliSourceForbidsSystemRoles.Condition.StringEquals).toEqual({
      'events:source': 'millwright.cli',
    });
    const cliPatterns = JSON.stringify(bySid.CliSourceForbidsSystemRoles.Condition.StringLike);
    expect(cliPatterns).toContain(':role/ci-poller');
    expect(cliPatterns).toContain(':role/ci-job-*');
  });
});
