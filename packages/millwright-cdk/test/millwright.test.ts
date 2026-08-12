import { App, Duration, Stack } from 'aws-cdk-lib';
import { Annotations, Match, Template } from 'aws-cdk-lib/assertions';
import * as iam from 'aws-cdk-lib/aws-iam';
import { describe, expect, it } from 'vitest';
import { Boundary, Millwright, MillwrightProps, SUPPORTED_SCHEMA_VERSION, VERSION } from '../src';
import cdkPkg from '../package.json';

const BOUNDARY_ARN = 'arn:aws:iam::123456789012:policy/team-boundary';

function stackWith(props: MillwrightProps): { stack: Stack; millwright: Millwright } {
  const stack = new Stack(new App(), 'Test');
  return { stack, millwright: new Millwright(stack, 'Millwright', props) };
}

describe('permissionsBoundary', () => {
  it('throws at construct time when absent', () => {
    const stack = new Stack(new App(), 'Test');
    expect(() => new Millwright(stack, 'Millwright', {} as MillwrightProps)).toThrow(
      /permissions boundary/i,
    );
  });

  it('throws on a value that is neither an ARN nor Boundary.NONE', () => {
    const stack = new Stack(new App(), 'Test');
    expect(
      () => new Millwright(stack, 'Millwright', { permissionsBoundary: 'team-boundary' }),
    ).toThrow(/managed policy ARN or Boundary\.NONE/);
  });

  it('synthesizes with a warning when Boundary.NONE is passed explicitly', () => {
    const { stack, millwright } = stackWith({ permissionsBoundary: Boundary.NONE });
    expect(millwright.permissionsBoundaryArn).toBeUndefined();
    Annotations.fromStack(stack).hasWarning(
      '/Test/Millwright',
      Match.stringLikeRegexp('no permissions boundary'),
    );
  });

  it('synthesizes without a warning and applies the boundary to roles in scope', () => {
    const { stack, millwright } = stackWith({ permissionsBoundary: BOUNDARY_ARN });
    new iam.Role(millwright, 'SampleRole', {
      assumedBy: new iam.ServicePrincipal('lambda.amazonaws.com'),
    });
    expect(millwright.permissionsBoundaryArn).toBe(BOUNDARY_ARN);
    Annotations.fromStack(stack).hasNoWarning('*', Match.anyValue());
    Template.fromStack(stack).hasResourceProperties('AWS::IAM::Role', {
      PermissionsBoundary: BOUNDARY_ARN,
    });
  });
});

/**
 * Manifest values now embed deploy-time tokens (bucket name, key ARN), so the
 * template renders them as Fn::Join. Flatten to parseable JSON by standing in
 * "TOKEN" for each intrinsic.
 */
function parseManifestValue(value: unknown): Record<string, unknown> {
  const text =
    typeof value === 'string'
      ? value
      : (value as { 'Fn::Join': [string, unknown[]] })['Fn::Join'][1]
          .map((part) => (typeof part === 'string' ? part : 'TOKEN'))
          .join('');
  return JSON.parse(text);
}

describe('manifest parameter', () => {
  it('self-registers the manifest at /millwright/<name>/manifest', () => {
    const { stack, millwright } = stackWith({ permissionsBoundary: BOUNDARY_ARN });
    expect(millwright.manifestParameterName).toBe('/millwright/millwright/manifest');
    const template = Template.fromStack(stack);
    template.resourceCountIs('AWS::SSM::Parameter', 1);
    const [param] = Object.values(template.findResources('AWS::SSM::Parameter'));
    expect(param.Properties.Name).toBe('/millwright/millwright/manifest');
    const manifest = parseManifestValue(param.Properties.Value);
    expect(manifest).toEqual({
      deploymentName: 'millwright',
      version: VERSION,
      schemaVersion: SUPPORTED_SCHEMA_VERSION,
      pollCadenceSeconds: 60,
      retention: { logDays: 30, metadataDays: 90, artifactDays: 90, cacheDays: 14 },
      permissionsBoundary: BOUNDARY_ARN,
      resources: {
        stateTable: 'millwright-state',
        pollingTable: 'millwright-polling',
        artifactBucket: 'TOKEN',
        buildLogGroup: '/millwright/millwright/builds',
        configKeyArn: 'TOKEN',
        configKeyAlias: 'alias/millwright/millwright',
        eventBus: 'millwright-bus',
      },
    });
  });

  it('namespaces the manifest by deploymentName', () => {
    const { millwright } = stackWith({
      permissionsBoundary: BOUNDARY_ARN,
      deploymentName: 'ci-platform',
    });
    expect(millwright.manifestParameterName).toBe('/millwright/ci-platform/manifest');
  });

  it('rejects deployment names that cannot namespace SSM paths', () => {
    for (const bad of ['Millwright', 'has space', '-leading', 'a/b', '']) {
      const stack = new Stack(new App(), 'Test');
      expect(
        () =>
          new Millwright(stack, 'Millwright', {
            permissionsBoundary: BOUNDARY_ARN,
            deploymentName: bad,
          }),
      ).toThrow(/deploymentName/);
    }
  });
});

describe('defaults', () => {
  it('applies the documented prop defaults', () => {
    const { millwright } = stackWith({ permissionsBoundary: BOUNDARY_ARN });
    expect(millwright.deploymentName).toBe('millwright');
    expect(millwright.pollCadence.toSeconds()).toBe(Duration.minutes(1).toSeconds());
    expect(millwright.logRetention.toDays()).toBe(30);
    expect(millwright.metadataRetention.toDays()).toBe(90);
    expect(millwright.artifactRetention.toDays()).toBe(90);
    expect(millwright.cacheRetention.toDays()).toBe(14);
  });

  it('honours overrides', () => {
    const { millwright } = stackWith({
      permissionsBoundary: BOUNDARY_ARN,
      pollCadence: Duration.minutes(5),
      retention: {
        logs: Duration.days(7),
        metadata: Duration.days(30),
        artifacts: Duration.days(60),
        cache: Duration.days(3),
      },
    });
    expect(millwright.pollCadence.toMinutes()).toBe(5);
    expect(millwright.logRetention.toDays()).toBe(7);
    expect(millwright.metadataRetention.toDays()).toBe(30);
    expect(millwright.artifactRetention.toDays()).toBe(60);
    expect(millwright.cacheRetention.toDays()).toBe(3);
  });
});

describe('lockstep version', () => {
  it('keeps the embedded VERSION in sync with package.json', () => {
    expect(VERSION).toBe(cdkPkg.version);
  });
});
