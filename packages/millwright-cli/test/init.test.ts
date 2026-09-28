import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { init, initNextSteps } from '../src';
import { VERSION } from '../src/version';

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'millwright-init-'));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('millwright init', () => {
  it('scaffolds the two-file CDK app plus npm plumbing', () => {
    const result = init({ directory: dir });
    expect(result.files).toEqual(
      expect.arrayContaining(['app.ts', 'cdk.json', 'package.json', 'tsconfig.json', '.gitignore']),
    );

    const app = readFileSync(join(dir, 'app.ts'), 'utf8');
    expect(app).toContain("new Millwright(stack, 'Millwright'");
    expect(app).toContain("deploymentName: 'millwright'");
    expect(app).toContain('permissionsBoundary: Boundary.NONE');
    expect(app).toContain('TODO: replace Boundary.NONE');

    const cdkJson = JSON.parse(readFileSync(join(dir, 'cdk.json'), 'utf8'));
    expect(cdkJson.app).toContain('app.ts');

    const pkg = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8'));
    expect(pkg.dependencies['@copperbox/millwright-cdk']).toMatch(/^\^\d+\.\d+\.\d+$/);
    expect(pkg.dependencies['aws-cdk-lib']).toBeDefined();
    // The CLI rides along so `npx millwright setup` resolves inside the app
    // directory instead of falling through to the unscoped npm package.
    expect(pkg.devDependencies['@copperbox/millwright-cli']).toBe(`^${VERSION}`);
    expect(pkg.dependencies['@copperbox/millwright-cli']).toBeUndefined();
  });

  it('inlines a provided permissions boundary ARN', () => {
    const arn = 'arn:aws:iam::123456789012:policy/team-boundary';
    init({ directory: dir, permissionsBoundary: arn, deploymentName: 'ci-platform' });
    const app = readFileSync(join(dir, 'app.ts'), 'utf8');
    expect(app).toContain(`permissionsBoundary: '${arn}'`);
    expect(app).toContain("deploymentName: 'ci-platform'");
    expect(app).not.toContain('Boundary.NONE');
    expect(app).not.toContain('TODO');
  });

  it('refuses to overwrite existing files', () => {
    writeFileSync(join(dir, 'app.ts'), '// mine');
    expect(() => init({ directory: dir })).toThrow(/Refusing to overwrite.*app\.ts/);
    expect(readFileSync(join(dir, 'app.ts'), 'utf8')).toBe('// mine');
  });
});

describe('initNextSteps', () => {
  const tail = 'npm install && npx cdk deploy, then npx millwright setup.';

  it('omits the cd step when the scaffold is the current directory', () => {
    expect(initNextSteps('.')).toBe(`Next: ${tail}`);
    expect(initNextSteps(process.cwd())).toBe(`Next: ${tail}`);
  });

  it('leads with cd into a named directory so every command runs in the scaffold', () => {
    expect(initNextSteps('deploy')).toBe(`Next: cd deploy && ${tail}`);
    expect(initNextSteps('../infra/millwright')).toBe(`Next: cd ../infra/millwright && ${tail}`);
  });

  it('single-quotes directories a shell would otherwise split or expand', () => {
    expect(initNextSteps('my deploy')).toBe(`Next: cd 'my deploy' && ${tail}`);
    expect(initNextSteps("it's $HOME")).toBe(`Next: cd 'it'\\''s $HOME' && ${tail}`);
  });
});
