import { describe, expect, it } from 'vitest';
import {
  GithubCredentialsFormatError,
  parseGithubCredentials,
  serializeGithubCredentials,
} from '../src';

const PEM = '-----BEGIN RSA PRIVATE KEY-----\nMIIE...\n-----END RSA PRIVATE KEY-----\n';

describe('serializeGithubCredentials / parseGithubCredentials', () => {
  it('round-trips App credentials', () => {
    const creds = {
      mode: 'app' as const,
      appId: 12345,
      slug: 'millwright-ci',
      privateKeyPem: PEM,
    };
    expect(parseGithubCredentials(serializeGithubCredentials(creds))).toEqual(creds);
  });

  it('round-trips PAT credentials', () => {
    const creds = { mode: 'pat' as const, token: 'github_pat_11AAAA' };
    expect(parseGithubCredentials(serializeGithubCredentials(creds))).toEqual(creds);
  });

  it('rejects unparseable JSON, unknown modes, and missing fields', () => {
    expect(() => parseGithubCredentials('nope')).toThrow(GithubCredentialsFormatError);
    expect(() => parseGithubCredentials('{"mode":"oauth"}')).toThrow(GithubCredentialsFormatError);
    expect(() => parseGithubCredentials('{"mode":"app","appId":"12"}')).toThrow(
      GithubCredentialsFormatError,
    );
    expect(() => parseGithubCredentials(`{"mode":"app","appId":12}`)).toThrow(
      GithubCredentialsFormatError,
    );
    expect(() => parseGithubCredentials('{"mode":"pat"}')).toThrow(GithubCredentialsFormatError);
    expect(() => parseGithubCredentials('{"mode":"pat","token":""}')).toThrow(
      GithubCredentialsFormatError,
    );
  });
});
