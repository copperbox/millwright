import { utils } from 'ssh2';
import { describe, expect, it } from 'vitest';
import { generateDeployKey } from '../src/github/deploy-key';

describe('generateDeployKey', () => {
  const pair = generateDeployKey('millwright/prod copperbox/millwright');

  it('produces an OpenSSH-format Ed25519 private key ssh2 can parse', () => {
    expect(pair.privateKey).toMatch(/^-----BEGIN OPENSSH PRIVATE KEY-----\n/);
    const parsed = utils.parseKey(pair.privateKey);
    expect(parsed).not.toBeInstanceOf(Error);
    expect((parsed as { type: string }).type).toBe('ssh-ed25519');
  });

  it('produces a single-line public key GitHub deploy-key creation accepts', () => {
    expect(pair.publicKey).toMatch(
      /^ssh-ed25519 [A-Za-z0-9+/=]+ millwright\/prod copperbox\/millwright$/,
    );
    expect(pair.publicKey).not.toContain('\n');
  });

  it('public and private halves belong together', () => {
    const parsed = utils.parseKey(pair.privateKey) as {
      getPublicSSH(): Buffer;
    };
    const publicBlob = Buffer.from(pair.publicKey.split(' ')[1], 'base64');
    expect(parsed.getPublicSSH().equals(publicBlob)).toBe(true);
  });

  it('stays in SSM standard-tier territory (~400 B, spec §9.2)', () => {
    expect(pair.privateKey.length).toBeLessThan(500);
  });

  it('generates a fresh key every call', () => {
    expect(generateDeployKey('c').privateKey).not.toBe(generateDeployKey('c').privateKey);
  });
});
