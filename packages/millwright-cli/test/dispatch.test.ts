import { GetParameterCommand, GetParametersByPathCommand } from '@aws-sdk/client-ssm';
import { BusEventDetail, RegistryItem, registryKey } from '@copperbox/millwright-state';
import { describe, expect, it } from 'vitest';
import {
  DispatchDeps,
  DispatchError,
  dispatch,
  parseInputArgs,
  repoFromRemoteUrl,
} from '../src/dispatch';
import { SsmClientLike } from '../src/discovery';

const SHA_MAIN = 'a'.repeat(40);
const SHA_TAG = 'b'.repeat(40);
const SHA_DEV = 'c'.repeat(40);

function fakeSsm(): SsmClientLike {
  const manifest = {
    Name: '/millwright/ci/manifest',
    Value: JSON.stringify({
      deploymentName: 'ci',
      version: '0.1.0',
      schemaVersion: 1,
      resources: { eventBus: 'ci-bus', stateTable: 'ci-state' },
    }),
  };
  return {
    async send(command: unknown) {
      if (command instanceof GetParametersByPathCommand) {
        return { Parameters: [manifest] };
      }
      if (command instanceof GetParameterCommand) {
        return { Parameter: manifest };
      }
      throw new Error('unexpected command');
    },
  };
}

/** ls-remote fixture for octo/app: main (default, HEAD), dev, tag v1. */
const REMOTE_REFS: Record<string, string> = {
  'refs/heads/main': SHA_MAIN,
  'refs/heads/dev': SHA_DEV,
  'refs/tags/v1': SHA_TAG,
};

function fakeGit(remoteUrl = 'git@github.com:octo/app.git') {
  const calls: string[][] = [];
  const runGit = async (args: readonly string[]): Promise<string> => {
    calls.push([...args]);
    if (args[0] === 'remote') {
      return `${remoteUrl}\n`;
    }
    if (args[0] === 'ls-remote') {
      const patterns = args.slice(3);
      const lines: string[] = [];
      for (const pattern of patterns) {
        if (pattern === 'HEAD') {
          lines.push('ref: refs/heads/main\tHEAD', `${SHA_MAIN}\tHEAD`);
        } else if (REMOTE_REFS[pattern]) {
          lines.push(`${REMOTE_REFS[pattern]}\t${pattern}`);
        }
      }
      return `${lines.join('\n')}\n`;
    }
    throw new Error(`unexpected git ${args[0]}`);
  };
  return { runGit, calls };
}

function registryEntry(
  workflows: Record<string, { triggers: unknown }>,
  repo = 'octo/app',
  ref = 'refs/heads/main',
): RegistryItem {
  return { ...registryKey(repo, ref), repo, ref, schemaVersion: 1, workflows };
}

const MANUAL_ONLY = {
  deploy: { triggers: [{ kind: 'manual', inputs: {} }] },
};

function harness(options?: {
  remoteUrl?: string;
  entries?: Map<string, RegistryItem>;
}) {
  const { runGit, calls } = fakeGit(options?.remoteUrl);
  const entries =
    options?.entries ?? new Map([['octo/app|refs/heads/main', registryEntry(MANUAL_ONLY)]]);
  const put: { busName: string; detail: BusEventDetail }[] = [];
  const registryReads: string[] = [];
  const lines: string[] = [];
  const deps: DispatchDeps = {
    ssm: fakeSsm(),
    runGit,
    getRegistryEntry: async (tableName, repo, ref) => {
      registryReads.push(`${tableName}|${repo}|${ref}`);
      return entries.get(`${repo}|${ref}`);
    },
    putEvent: async (busName, detail) => {
      put.push({ busName, detail });
    },
    stdout: (line) => lines.push(line),
  };
  return { deps, put, calls, registryReads, lines, entries };
}

describe('repoFromRemoteUrl', () => {
  it('parses the usual GitHub remote forms', () => {
    expect(repoFromRemoteUrl('git@github.com:octo/app.git')).toBe('octo/app');
    expect(repoFromRemoteUrl('ssh://git@github.com/octo/app.git')).toBe('octo/app');
    expect(repoFromRemoteUrl('https://github.com/octo/app.git')).toBe('octo/app');
    expect(repoFromRemoteUrl('https://github.com/octo/app')).toBe('octo/app');
  });

  it('rejects what it cannot parse', () => {
    expect(repoFromRemoteUrl('https://example.com/elsewhere')).toBeUndefined();
    expect(repoFromRemoteUrl('/local/path/repo.git')).toBeUndefined();
  });
});

describe('parseInputArgs', () => {
  it('parses repeated k=v pairs, keeping = inside values', () => {
    expect(parseInputArgs(['env=prod', 'flag=a=b'])).toEqual({ env: 'prod', flag: 'a=b' });
  });

  it('rejects malformed and duplicate inputs', () => {
    expect(() => parseInputArgs(['noequals'])).toThrow(DispatchError);
    expect(() => parseInputArgs(['=v'])).toThrow(DispatchError);
    expect(() => parseInputArgs(['a=1', 'a=2'])).toThrow(DispatchError);
  });
});

describe('dispatch', () => {
  it('dispatches the default-branch head when no ref is given', async () => {
    const { deps, put, lines } = harness();
    await dispatch({ workflow: 'deploy' }, deps);
    expect(put).toEqual([
      {
        busName: 'ci-bus',
        detail: {
          repo: 'octo/app',
          ref: 'refs/heads/main',
          sha: SHA_MAIN,
          kind: 'dispatch',
          defaultBranch: 'main',
          workflow: 'deploy',
        },
      },
    ]);
    expect(lines.join('\n')).toContain('deploy');
  });

  it('resolves a short branch name, then a tag, then accepts a full ref', async () => {
    const { deps, put } = harness();
    await dispatch({ workflow: 'deploy', ref: 'dev' }, deps);
    await dispatch({ workflow: 'deploy', ref: 'v1' }, deps);
    await dispatch({ workflow: 'deploy', ref: 'refs/tags/v1' }, deps);
    expect(put.map((p) => `${p.detail.ref}@${p.detail.sha}`)).toEqual([
      `refs/heads/dev@${SHA_DEV}`,
      `refs/tags/v1@${SHA_TAG}`,
      `refs/tags/v1@${SHA_TAG}`,
    ]);
  });

  it('fails when the ref does not exist on the remote', async () => {
    const { deps, put } = harness();
    await expect(dispatch({ workflow: 'deploy', ref: 'gone' }, deps)).rejects.toThrow(
      /not found on origin/,
    );
    expect(put).toEqual([]);
  });

  it('falls back to the default-branch registry entry for a never-synthed ref', async () => {
    const { deps, registryReads, put } = harness();
    await dispatch({ workflow: 'deploy', ref: 'dev' }, deps);
    expect(registryReads).toEqual([
      'ci-state|octo/app|refs/heads/dev',
      'ci-state|octo/app|refs/heads/main',
    ]);
    expect(put).toHaveLength(1);
  });

  it('types declared inputs: choices validated, booleans coerced, defaults applied', async () => {
    const entries = new Map([
      [
        'octo/app|refs/heads/main',
        registryEntry({
          deploy: {
            triggers: [
              {
                kind: 'manual',
                inputs: {
                  env: { choices: ['staging', 'prod'], default: 'staging' },
                  dryRun: { type: 'boolean', default: true },
                  notify: { type: 'boolean' },
                },
              },
            ],
          },
        }),
      ],
    ]);
    const { deps, put } = harness({ entries });
    await dispatch({ workflow: 'deploy', inputs: ['env=prod', 'notify=false'] }, deps);
    expect(put[0].detail.inputs).toEqual({ env: 'prod', notify: false, dryRun: true });
  });

  it('rejects unknown inputs, bad choices and non-boolean values', async () => {
    const entries = new Map([
      [
        'octo/app|refs/heads/main',
        registryEntry({
          deploy: {
            triggers: [
              {
                kind: 'manual',
                inputs: { env: { choices: ['staging', 'prod'] }, dryRun: { type: 'boolean' } },
              },
            ],
          },
        }),
      ],
    ]);
    const { deps } = harness({ entries });
    await expect(dispatch({ workflow: 'deploy', inputs: ['nope=1'] }, deps)).rejects.toThrow(
      /does not declare an input "nope"/,
    );
    await expect(dispatch({ workflow: 'deploy', inputs: ['env=qa'] }, deps)).rejects.toThrow(
      /must be one of/,
    );
    await expect(dispatch({ workflow: 'deploy', inputs: ['dryRun=yes'] }, deps)).rejects.toThrow(
      /true or false/,
    );
  });

  it('rejects a workflow that is unregistered or lacks a manual trigger', async () => {
    const entries = new Map([
      [
        'octo/app|refs/heads/main',
        registryEntry({
          ci: { triggers: [{ kind: 'push' }] },
        }),
      ],
    ]);
    const { deps } = harness({ entries });
    await expect(dispatch({ workflow: 'deploy' }, deps)).rejects.toThrow(/not registered/);
    await expect(dispatch({ workflow: 'ci' }, deps)).rejects.toThrow(/Trigger\.manual/);
  });

  it('proceeds without a registry entry (launcher bootstraps) but refuses untyped inputs', async () => {
    const { deps, put } = harness({ entries: new Map() });
    await dispatch({ workflow: 'deploy' }, deps);
    expect(put).toHaveLength(1);
    await expect(dispatch({ workflow: 'deploy', inputs: ['a=1'] }, deps)).rejects.toThrow(
      /registry entry/,
    );
  });

  it('honours --repo over the origin remote and rejects unparseable remotes', async () => {
    const { deps, put } = harness({
      remoteUrl: 'https://example.com/elsewhere.git',
      entries: new Map([['octo/lib|refs/heads/main', registryEntry(MANUAL_ONLY, 'octo/lib')]]),
    });
    await expect(dispatch({ workflow: 'deploy' }, deps)).rejects.toThrow(/origin remote/);
    await dispatch({ workflow: 'deploy', repo: 'octo/lib' }, deps);
    expect(put[0].detail.repo).toBe('octo/lib');
  });

  it('fails cleanly when the manifest lacks the bus or state-table resources', async () => {
    const { deps } = harness();
    const bareManifest = {
      Name: '/millwright/ci/manifest',
      Value: JSON.stringify({ deploymentName: 'ci', version: '0.0.1', schemaVersion: 1 }),
    };
    const ssm: SsmClientLike = {
      async send(command: unknown) {
        if (command instanceof GetParametersByPathCommand) {
          return { Parameters: [bareManifest] };
        }
        return { Parameter: bareManifest };
      },
    };
    await expect(dispatch({ workflow: 'deploy' }, { ...deps, ssm })).rejects.toThrow(/manifest/);
  });
});
