/**
 * Per-repo read-only Ed25519 deploy keys (spec §13.1, §9.2). ssh2's own
 * generator emits the OpenSSH formats both consumers need verbatim: the
 * private key (~400 B — SSM standard tier) for the poller's ssh2 sessions,
 * the single-line public key for GitHub's deploy-key API.
 */

import { utils } from 'ssh2';

export interface DeployKeyPair {
  /** Single-line `ssh-ed25519 <base64> <comment>` for the GitHub API. */
  readonly publicKey: string;
  /** OpenSSH-format private key PEM, stored as the deploy-key SecureString. */
  readonly privateKey: string;
}

export function generateDeployKey(comment: string): DeployKeyPair {
  const pair = utils.generateKeyPairSync('ed25519', { comment });
  return { publicKey: pair.public, privateKey: pair.private };
}
