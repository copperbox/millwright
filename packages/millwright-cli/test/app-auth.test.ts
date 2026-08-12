import { createVerify, generateKeyPairSync } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { signAppJwt } from '../src/github/app-auth';

const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
const PEM = privateKey.export({ type: 'pkcs1', format: 'pem' }).toString();

function decodeSegment(segment: string): Record<string, unknown> {
  return JSON.parse(Buffer.from(segment, 'base64url').toString('utf8'));
}

describe('signAppJwt', () => {
  const now = 1_754_000_000;
  const jwt = signAppJwt(12345, PEM, now);
  const [header, payload, signature] = jwt.split('.');

  it('is a valid RS256 JWT for the App id', () => {
    expect(decodeSegment(header)).toEqual({ alg: 'RS256', typ: 'JWT' });
    const claims = decodeSegment(payload);
    expect(claims.iss).toBe('12345');
    // Backdated 60s against clock drift; expiry inside GitHub's 10-minute cap.
    expect(claims.iat).toBe(now - 60);
    expect(claims.exp).toBe(now + 540);
  });

  it('carries a signature the corresponding public key verifies', () => {
    const verifier = createVerify('RSA-SHA256');
    verifier.update(`${header}.${payload}`);
    expect(verifier.verify(publicKey, Buffer.from(signature, 'base64url'))).toBe(true);
  });

  it('never emits base64 padding or URL-hostile characters', () => {
    expect(jwt).not.toMatch(/[+/=]/);
  });
});
