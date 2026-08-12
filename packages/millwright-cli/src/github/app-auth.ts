/**
 * GitHub App JWT minting (spec §13.1). RS256 over the App's manifest-exchange
 * private key, claims per GitHub's App-auth contract: iat backdated 60s
 * against clock drift, expiry well inside the 10-minute cap, issuer = App id.
 */

import { createSign } from 'node:crypto';

function base64url(input: Buffer | string): string {
  return Buffer.from(input).toString('base64url');
}

export function signAppJwt(appId: number, privateKeyPem: string, nowSeconds: number): string {
  const header = base64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
  const payload = base64url(
    JSON.stringify({ iat: nowSeconds - 60, exp: nowSeconds + 540, iss: String(appId) }),
  );
  const signer = createSign('RSA-SHA256');
  signer.update(`${header}.${payload}`);
  const signature = signer.sign(privateKeyPem).toString('base64url');
  return `${header}.${payload}.${signature}`;
}
