import {
  GetParameterCommand,
  GetParametersByPathCommand,
  GetParametersCommand,
  ParameterNotFound,
} from '@aws-sdk/client-ssm';
import { describe, expect, it } from 'vitest';
import { SsmConfigPlane } from '../src/runtime/poller/config';

interface FakeParameter {
  readonly name: string;
  readonly value: string;
}

/** Minimal SSM fake: path listing with pagination, GetParameters, GetParameter. */
class FakeSsm {
  readonly getParametersCalls: string[][] = [];

  constructor(
    private readonly parameters: FakeParameter[],
    private readonly pageSize = 2,
  ) {}

  async send(command: unknown): Promise<unknown> {
    if (command instanceof GetParametersByPathCommand) {
      const { Path, NextToken } = command.input;
      const matching = this.parameters.filter((p) => p.name.startsWith(`${Path}/`));
      const start = NextToken ? Number(NextToken) : 0;
      const page = matching.slice(start, start + this.pageSize);
      return {
        Parameters: page.map((p) => ({ Name: p.name, Value: p.value })),
        NextToken: start + this.pageSize < matching.length ? String(start + this.pageSize) : undefined,
      };
    }
    if (command instanceof GetParametersCommand) {
      const names = command.input.Names ?? [];
      this.getParametersCalls.push([...names]);
      expect(names.length).toBeLessThanOrEqual(10);
      const found = this.parameters.filter((p) => names.includes(p.name));
      return {
        Parameters: found.map((p) => ({ Name: p.name, Value: p.value })),
        InvalidParameters: names.filter((n) => !found.some((p) => p.name === n)),
      };
    }
    if (command instanceof GetParameterCommand) {
      const parameter = this.parameters.find((p) => p.name === command.input.Name);
      if (!parameter) {
        throw new ParameterNotFound({ message: 'not found', $metadata: {} });
      }
      return { Parameter: { Name: parameter.name, Value: parameter.value } };
    }
    throw new Error('unexpected command');
  }
}

const ROOT = '/millwright/mw/repos';

describe('SsmConfigPlane', () => {
  it('discovers repos from config parameters across pages, ignoring other rows', async () => {
    const ssm = new FakeSsm([
      { name: `${ROOT}/octo/app/config`, value: '{}' },
      { name: `${ROOT}/octo/app/deploy-key`, value: 'ciphertext' },
      { name: `${ROOT}/octo/lib/config`, value: '{}' },
      { name: `${ROOT}/acme/site/config`, value: '{}' },
    ]);
    const plane = new SsmConfigPlane(ssm as never, 'mw');
    expect(await plane.listRepos()).toEqual(['acme/site', 'octo/app', 'octo/lib']);
  });

  it('batch-fetches deploy keys once and serves warm ticks from the cache', async () => {
    const repos = Array.from({ length: 12 }, (_, i) => `octo/repo-${String(i).padStart(2, '0')}`);
    const ssm = new FakeSsm(
      repos.map((repo) => ({ name: `${ROOT}/${repo}/deploy-key`, value: `KEY-${repo}` })),
    );
    const plane = new SsmConfigPlane(ssm as never, 'mw');

    const keys = await plane.getDeployKeys(repos);
    expect(keys.size).toBe(12);
    expect(keys.get('octo/repo-03')).toBe('KEY-octo/repo-03');
    // 12 names → two GetParameters batches (the API caps at ten).
    expect(ssm.getParametersCalls).toHaveLength(2);

    // Warm tick: nothing re-fetched.
    await plane.getDeployKeys(repos);
    expect(ssm.getParametersCalls).toHaveLength(2);

    // Eviction forces a single-name re-fetch.
    plane.evictDeployKey('octo/repo-03');
    await plane.getDeployKeys(repos);
    expect(ssm.getParametersCalls).toHaveLength(3);
    expect(ssm.getParametersCalls[2]).toEqual([`${ROOT}/octo/repo-03/deploy-key`]);
  });

  it('omits repos whose deploy-key parameter is missing', async () => {
    const ssm = new FakeSsm([{ name: `${ROOT}/octo/app/deploy-key`, value: 'KEY' }]);
    const plane = new SsmConfigPlane(ssm as never, 'mw');
    const keys = await plane.getDeployKeys(['octo/app', 'octo/gone']);
    expect([...keys.keys()]).toEqual(['octo/app']);
  });

  it('captures the tier-2 toggles from the same listing that discovers repos', async () => {
    const ssm = new FakeSsm([
      { name: `${ROOT}/octo/app/config`, value: '{"forkPrPolicy":"on"}' },
      { name: `${ROOT}/octo/lib/config`, value: '{"prPolling":false}' },
      { name: `${ROOT}/octo/odd/config`, value: 'not json' },
    ]);
    const plane = new SsmConfigPlane(ssm as never, 'mw');

    // Before any listing: the defaults.
    expect(plane.getRepoConfig('octo/app')).toEqual({ prPolling: true, forkPrPolicy: false });

    await plane.listRepos();
    expect(plane.getRepoConfig('octo/app')).toEqual({ prPolling: true, forkPrPolicy: true });
    expect(plane.getRepoConfig('octo/lib')).toEqual({ prPolling: false, forkPrPolicy: false });
    expect(plane.getRepoConfig('octo/odd')).toEqual({ prPolling: true, forkPrPolicy: false });
    expect(plane.getRepoConfig('octo/unknown')).toEqual({ prPolling: true, forkPrPolicy: false });
  });

  it('reads the github/app parameter, undefined until setup seeds it', async () => {
    const empty = new SsmConfigPlane(new FakeSsm([]) as never, 'mw');
    expect(await empty.getGithubAppParameter()).toBeUndefined();

    const ssm = new FakeSsm([{ name: '/millwright/mw/github/app', value: '{"appId":1}' }]);
    const plane = new SsmConfigPlane(ssm as never, 'mw');
    expect(await plane.getGithubAppParameter()).toBe('{"appId":1}');
  });

  it('treats a missing host-keys parameter as undefined', async () => {
    const plane = new SsmConfigPlane(new FakeSsm([]) as never, 'mw');
    expect(await plane.getHostKeysParameter()).toBeUndefined();
  });

  it('returns the host-keys parameter when seeded', async () => {
    const ssm = new FakeSsm([
      { name: '/millwright/mw/github/host-keys', value: 'ssh-ed25519 AAAA' },
    ]);
    const plane = new SsmConfigPlane(ssm as never, 'mw');
    expect(await plane.getHostKeysParameter()).toBe('ssh-ed25519 AAAA');
  });
});
