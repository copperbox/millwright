import { RunItem, registryKey, runKey } from '@copperbox/millwright-state';
import { describe, expect, it } from 'vitest';
import { CommandError } from '../src/config-plane';
import { discoverDeployment } from '../src/discovery';
import {
  StateReadContext,
  discoverWorkflows,
  formatRunId,
  parseRunRef,
  resolveRun,
  resolveWorkflow,
} from '../src/run-ref';
import { FakeDdb } from './fake-ddb';
import { FakeSsm } from './fake-ssm';

const TABLE = 'millwright-prod-state';

function registryItem(repo: string, ref: string, workflows: string[]) {
  return {
    ...registryKey(repo, ref),
    repo,
    ref,
    schemaVersion: 1,
    workflows: Object.fromEntries(workflows.map((w) => [w, { triggers: {} }])),
  };
}

function runItem(
  repo: string,
  workflow: string,
  runNumber: number,
  overrides: Partial<RunItem> = {},
): RunItem {
  return {
    ...runKey({ repo, workflow, runNumber }),
    repo,
    workflow,
    runNumber,
    status: 'SUCCEEDED',
    trigger: 'push',
    ref: 'refs/heads/main',
    sha: 'c0ffee0000000000000000000000000000000000',
    createdAt: `2026-08-12T0${runNumber}:00:00Z`,
    originalStartedAt: `2026-08-12T0${runNumber}:00:00Z`,
    expiresAt: 1790000000,
    ...overrides,
  } as RunItem;
}

async function makeContext(): Promise<{ context: StateReadContext; ddb: FakeDdb }> {
  const ssm = new FakeSsm();
  ssm.setManifest('prod', { stateTable: TABLE });
  ssm.set('/millwright/prod/repos/acme/api/config', '{}');
  ssm.set('/millwright/prod/repos/acme/web/config', '{}');
  const ddb = new FakeDdb();
  ddb.put(TABLE, registryItem('acme/api', 'refs/heads/main', ['ci', 'deploy']));
  ddb.put(TABLE, registryItem('acme/api', 'refs/heads/dev', ['ci']));
  ddb.put(TABLE, registryItem('acme/web', 'refs/heads/main', ['ci']));
  const deployment = await discoverDeployment(ssm, {});
  return { context: { ssm, ddb, deployment, stateTable: TABLE }, ddb };
}

describe('parseRunRef', () => {
  it('parses workflow-scoped ids', () => {
    expect(parseRunRef('ci#142')).toEqual({ workflow: 'ci', runNumber: 142 });
    expect(parseRunRef('ci')).toEqual({ workflow: 'ci', runNumber: undefined });
  });

  it('parses repo-qualified ids', () => {
    expect(parseRunRef('acme/api/ci#7')).toEqual({ repo: 'acme/api', workflow: 'ci', runNumber: 7 });
    expect(parseRunRef('acme/api/ci')).toEqual({ repo: 'acme/api', workflow: 'ci', runNumber: undefined });
  });

  it('rejects malformed ids', () => {
    expect(() => parseRunRef('ci#')).toThrow(CommandError);
    expect(() => parseRunRef('ci#0')).toThrow(CommandError);
    expect(() => parseRunRef('ci#abc')).toThrow(CommandError);
    expect(() => parseRunRef('#7')).toThrow(CommandError);
    expect(() => parseRunRef('acme/ci#7')).toThrow(/ambiguous/);
  });
});

describe('discoverWorkflows', () => {
  it('unions registry workflow names across refs per configured repo', async () => {
    const { context } = await makeContext();
    expect(await discoverWorkflows(context)).toEqual([
      { repo: 'acme/api', workflow: 'ci' },
      { repo: 'acme/api', workflow: 'deploy' },
      { repo: 'acme/web', workflow: 'ci' },
    ]);
  });
});

describe('resolveWorkflow', () => {
  it('resolves a unique workflow name', async () => {
    const { context } = await makeContext();
    expect(await resolveWorkflow(context, { workflow: 'deploy' })).toEqual({
      repo: 'acme/api',
      workflow: 'deploy',
    });
  });

  it('demands qualification when two repos share the name', async () => {
    const { context } = await makeContext();
    await expect(resolveWorkflow(context, { workflow: 'ci' })).rejects.toThrow(
      /acme\/api\/ci.*acme\/web\/ci/,
    );
  });

  it('accepts the qualified form', async () => {
    const { context } = await makeContext();
    expect(await resolveWorkflow(context, { repo: 'acme/web', workflow: 'ci' })).toEqual({
      repo: 'acme/web',
      workflow: 'ci',
    });
  });

  it('names known workflows when nothing matches', async () => {
    const { context } = await makeContext();
    await expect(resolveWorkflow(context, { workflow: 'nope' })).rejects.toThrow(
      /known: acme\/api\/ci, acme\/api\/deploy, acme\/web\/ci/,
    );
  });
});

describe('resolveRun', () => {
  it('resolves an exact run id', async () => {
    const { context, ddb } = await makeContext();
    ddb.put(TABLE, runItem('acme/api', 'deploy', 2) as any);
    const run = await resolveRun(context, 'deploy#2');
    expect(formatRunId(run)).toBe('deploy#2');
  });

  it('defaults a bare workflow to its latest run', async () => {
    const { context, ddb } = await makeContext();
    ddb.put(TABLE, runItem('acme/api', 'deploy', 1) as any);
    ddb.put(TABLE, runItem('acme/api', 'deploy', 3) as any);
    const run = await resolveRun(context, 'deploy');
    expect(run.runNumber).toBe(3);
  });

  it('defaults no argument to the newest run across all workflows', async () => {
    const { context, ddb } = await makeContext();
    ddb.put(TABLE, runItem('acme/api', 'deploy', 1) as any);
    ddb.put(TABLE, runItem('acme/web', 'ci', 4, { createdAt: '2026-08-12T09:30:00Z' }) as any);
    const run = await resolveRun(context, undefined);
    expect(run.repo).toBe('acme/web');
    expect(run.runNumber).toBe(4);
  });

  it('fails plainly when the run does not exist', async () => {
    const { context } = await makeContext();
    await expect(resolveRun(context, 'deploy#9')).rejects.toThrow(/no run deploy#9 in acme\/api/);
  });

  it('fails plainly when the deployment has no runs at all', async () => {
    const { context } = await makeContext();
    await expect(resolveRun(context, undefined)).rejects.toThrow(/no runs yet/);
  });
});
