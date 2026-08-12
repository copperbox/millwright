import { EventEmitter } from 'node:events';
import { describe, expect, it } from 'vitest';
import {
  HostKeyMismatchError,
  parseHostKeyPins,
  withUploadPack,
  SshClientLike,
} from '../src/git/ssh';

const PIN_A = Buffer.from('host-key-blob-a');
const PIN_B = Buffer.from('host-key-blob-b');

function pinLine(blob: Buffer, algo = 'ssh-ed25519'): string {
  return `github.com ${algo} ${blob.toString('base64')}`;
}

/** Fake ssh2 Client: records connect config, scripts the ready/exec cycle. */
class FakeSshClient extends EventEmitter implements SshClientLike {
  config: any;
  execs: Array<{ command: string; options: any }> = [];
  ended = false;
  execError: Error | undefined;

  connect(config: any): this {
    this.config = config;
    queueMicrotask(() => {
      const verdict = config.hostVerifier ? config.hostVerifier(this.hostKeyBlob) : true;
      if (verdict) {
        this.emit('ready');
      }
      // A rejecting hostVerifier makes the real client emit an error.
      if (!verdict) {
        this.emit('error', new Error('Host verification failed'));
      }
    });
    return this;
  }

  hostKeyBlob: Buffer = PIN_A;

  exec(command: string, options: any, callback: (err: Error | undefined, stream: any) => void): boolean {
    this.execs.push({ command, options });
    const stream = new EventEmitter();
    (stream as any).write = () => true;
    queueMicrotask(() => callback(this.execError, this.execError ? undefined : stream));
    return true;
  }

  end(): void {
    this.ended = true;
  }
}

describe('parseHostKeyPins', () => {
  it('parses known_hosts-style lines into raw key blobs', () => {
    const value = [pinLine(PIN_A), pinLine(PIN_B, 'ssh-rsa'), '', '# comment'].join('\n');
    expect(parseHostKeyPins(value)).toEqual([PIN_A, PIN_B]);
  });

  it('parses bare "<algo> <base64>" lines as GitHub /meta serves them', () => {
    expect(parseHostKeyPins(`ssh-ed25519 ${PIN_A.toString('base64')}`)).toEqual([PIN_A]);
  });

  it('returns no pins for empty input', () => {
    expect(parseHostKeyPins('')).toEqual([]);
    expect(parseHostKeyPins('\n\n')).toEqual([]);
  });
});

describe('withUploadPack', () => {
  const options = {
    repo: 'copperbox/millwright',
    privateKey: 'fake-openssh-key',
    hostKeyPins: [PIN_A, PIN_B],
  };

  it('execs git-upload-pack for the repo with the v2 protocol env', async () => {
    const client = new FakeSshClient();
    const result = await withUploadPack(options, async () => 'done', () => client);
    expect(result).toBe('done');
    expect(client.config.host).toBe('github.com');
    expect(client.config.port).toBe(22);
    expect(client.config.username).toBe('git');
    expect(client.config.privateKey).toBe('fake-openssh-key');
    expect(client.execs).toEqual([
      {
        command: "git-upload-pack 'copperbox/millwright'",
        options: { env: { GIT_PROTOCOL: 'version=2' } },
      },
    ]);
    expect(client.ended).toBe(true);
  });

  it('accepts a host key matching any pin', async () => {
    const client = new FakeSshClient();
    client.hostKeyBlob = PIN_B;
    await expect(withUploadPack(options, async () => 'ok', () => client)).resolves.toBe('ok');
  });

  it('hard-fails on an unpinned host key without executing anything', async () => {
    const client = new FakeSshClient();
    client.hostKeyBlob = Buffer.from('evil-mitm-key');
    await expect(withUploadPack(options, async () => 'ok', () => client)).rejects.toThrow(
      HostKeyMismatchError,
    );
    expect(client.execs).toEqual([]);
  });

  it('refuses to run with no pins at all', async () => {
    const client = new FakeSshClient();
    await expect(
      withUploadPack({ ...options, hostKeyPins: [] }, async () => 'ok', () => client),
    ).rejects.toThrow(/host key/i);
  });

  it('rejects repo names that could escape the exec quoting', async () => {
    const client = new FakeSshClient();
    await expect(
      withUploadPack({ ...options, repo: "a/b'; rm -rf /" }, async () => 'ok', () => client),
    ).rejects.toThrow(/repo/i);
    expect(client.execs).toEqual([]);
  });

  it('ends the connection when the callback throws', async () => {
    const client = new FakeSshClient();
    await expect(
      withUploadPack(
        options,
        async () => {
          throw new Error('protocol exploded');
        },
        () => client,
      ),
    ).rejects.toThrow('protocol exploded');
    expect(client.ended).toBe(true);
  });

  it('surfaces exec failures and still closes', async () => {
    const client = new FakeSshClient();
    client.execError = new Error('channel open failure');
    await expect(withUploadPack(options, async () => 'ok', () => client)).rejects.toThrow(
      'channel open failure',
    );
    expect(client.ended).toBe(true);
  });
});
