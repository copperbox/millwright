import { existsSync, mkdirSync, writeFileSync } from 'fs';
import { join } from 'path';
import { VERSION } from './version';

export interface InitOptions {
  /** Directory to scaffold into. @default '.' */
  readonly directory?: string;
  /** @default 'millwright' */
  readonly deploymentName?: string;
  /** Managed policy ARN; omitted scaffolds Boundary.NONE with a loud comment. */
  readonly permissionsBoundary?: string;
}

export interface InitResult {
  readonly directory: string;
  readonly files: readonly string[];
}

function appTs(deploymentName: string, permissionsBoundary?: string): string {
  const boundaryImport = permissionsBoundary ? 'Millwright' : 'Boundary, Millwright';
  const boundaryValue = permissionsBoundary
    ? `'${permissionsBoundary}'`
    : `Boundary.NONE`;
  const boundaryComment = permissionsBoundary
    ? `  // The permissions boundary caps every role millwright creates, including
  // the job roles that repo-editable workflow definitions shape.`
    : `  // TODO: replace Boundary.NONE with your organization's permissions
  // boundary ARN. The boundary is the only cap on the IAM that repo-editable
  // workflow definitions can request; Boundary.NONE deploys without one and
  // is flagged with a synth-time warning.`;

  return `#!/usr/bin/env node
import { App, Stack } from 'aws-cdk-lib';
import { ${boundaryImport} } from '@copperbox/millwright-cdk';

const app = new App();
const stack = new Stack(app, '${pascalCase(deploymentName)}Stack');

new Millwright(stack, 'Millwright', {
  deploymentName: '${deploymentName}',
${boundaryComment}
  permissionsBoundary: ${boundaryValue},
});
`;
}

function pascalCase(name: string): string {
  return name
    .split(/[^a-zA-Z0-9]+/)
    .filter(Boolean)
    .map((part) => part[0].toUpperCase() + part.slice(1))
    .join('');
}

function scaffoldFiles(options: InitOptions): Record<string, string> {
  const deploymentName = options.deploymentName ?? 'millwright';
  return {
    // The CDK app proper is two files: app.ts + cdk.json. The rest is npm
    // plumbing so `npm install && npx cdk deploy` works out of the box.
    'app.ts': appTs(deploymentName, options.permissionsBoundary),
    'cdk.json': `${JSON.stringify({ app: 'npx ts-node app.ts' }, null, 2)}\n`,
    'package.json': `${JSON.stringify(
      {
        name: `${deploymentName}-deployment`,
        version: '0.0.0',
        private: true,
        scripts: {
          synth: 'cdk synth',
          deploy: 'cdk deploy',
          diff: 'cdk diff',
        },
        dependencies: {
          '@copperbox/millwright-cdk': `^${VERSION}`,
          'aws-cdk-lib': '^2.170.0',
          constructs: '^10.4.0',
        },
        devDependencies: {
          'aws-cdk': '^2.170.0',
          'ts-node': '^10.9.0',
          typescript: '~5.7.0',
        },
      },
      null,
      2,
    )}\n`,
    'tsconfig.json': `${JSON.stringify(
      {
        compilerOptions: {
          target: 'ES2022',
          module: 'commonjs',
          strict: true,
          esModuleInterop: true,
          skipLibCheck: true,
        },
      },
      null,
      2,
    )}\n`,
    '.gitignore': 'node_modules/\ncdk.out/\n',
  };
}

/**
 * `millwright init`: scaffold the minimal two-file CDK app (app.ts + cdk.json)
 * instantiating the Millwright construct. Refuses to overwrite existing files.
 */
export function init(options: InitOptions = {}): InitResult {
  const directory = options.directory ?? '.';
  const files = scaffoldFiles(options);

  const conflicts = Object.keys(files).filter((name) => existsSync(join(directory, name)));
  if (conflicts.length > 0) {
    throw new Error(
      `Refusing to overwrite existing file(s) in ${directory}: ${conflicts.join(', ')}. ` +
        'Run millwright init in an empty directory, or compose the Millwright construct ' +
        'into your existing CDK app instead.',
    );
  }

  mkdirSync(directory, { recursive: true });
  for (const [name, contents] of Object.entries(files)) {
    writeFileSync(join(directory, name), contents);
  }
  return { directory, files: Object.keys(files) };
}
