import { describe, expect, it } from 'vitest';
import pkg from '../package.json';

// The workflows library is the only install in watched repos: it must stay
// dependency-free, and in particular must never pull in aws-cdk-lib.
describe('dependency tree', () => {
  it('has no runtime, peer, or optional dependencies at all', () => {
    const manifest = pkg as Record<string, unknown>;
    expect(manifest.dependencies).toBeUndefined();
    expect(manifest.peerDependencies).toBeUndefined();
    expect(manifest.optionalDependencies).toBeUndefined();
  });

  it('never references aws-cdk-lib anywhere in its manifest', () => {
    expect(JSON.stringify(pkg)).not.toContain('aws-cdk-lib');
  });
});
