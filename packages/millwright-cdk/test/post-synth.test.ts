import {
  CheckStateItem,
  RegistryItem,
  TTL_ATTRIBUTE,
  checkStateKey,
  registryKey,
} from '@copperbox/millwright-state';
import { Trigger, Workflow, WorkflowSet, synthesize } from '@copperbox/millwright-workflows';
import { describe, expect, it } from 'vitest';
import {
  BOOTSTRAP_SYNTH_CHECK_CONTEXT,
  PostSynthDeps,
  PostSynthError,
  completePostSynth,
  synthCheckContext,
} from '../src/runtime/post-synth/post-synth';

const SHA = 'a'.repeat(40);
const NOW_MS = 1_754_000_000_000;

function modelJson(overrides: { repo?: string; commit?: string } = {}): string {
  const app = new WorkflowSet();
  const ci = new Workflow(app, 'ci', {
    on: [Trigger.push({ branches: ['main'] })],
    concurrency: { group: 'ci-${ref}', policy: 'queue' },
    image: 'public.ecr.aws/docker/library/node:22',
  });
  ci.job('build', { steps: ['npm ci', 'npm test'] });
  const { model } = synthesize(app, {
    repo: overrides.repo ?? 'octocat/app',
    commit: overrides.commit ?? SHA,
  });
  return JSON.stringify(model);
}

const RUN_INPUT = {
  action: 'run' as const,
  runId: 'octocat/app#ci#7',
  repo: 'octocat/app',
  workflow: 'ci',
  runNumber: 7,
  ref: 'refs/heads/main',
  sha: SHA,
  trigger: 'push',
};

const BOOTSTRAP_INPUT = {
  action: 'synth-only' as const,
  repo: 'octocat/app',
  ref: 'refs/heads/main',
  sha: SHA,
};

interface Harness {
  deps: PostSynthDeps;
  registryPuts: RegistryItem[];
  checkPuts: CheckStateItem[];
  reads: string[];
}

function harness(objects: Record<string, string>): Harness {
  const registryPuts: RegistryItem[] = [];
  const checkPuts: CheckStateItem[] = [];
  const reads: string[] = [];
  return {
    registryPuts,
    checkPuts,
    reads,
    deps: {
      config: { schemaCeiling: 1, metadataRetentionDays: 90 },
      readObject: async (key: string) => {
        reads.push(key);
        return objects[key];
      },
      store: {
        putRegistry: async (item: RegistryItem) => {
          registryPuts.push(item);
        },
        putCheckState: async (item: CheckStateItem) => {
          checkPuts.push(item);
        },
      },
      now: () => NOW_MS,
      log: () => {},
    },
  };
}

describe('synthCheckContext', () => {
  it('is workflow-scoped for runs, repo-level for bootstraps (spec §B2)', () => {
    expect(synthCheckContext(RUN_INPUT)).toBe('ci / synth');
    expect(synthCheckContext(BOOTSTRAP_INPUT)).toBe(BOOTSTRAP_SYNTH_CHECK_CONTEXT);
    expect(BOOTSTRAP_SYNTH_CHECK_CONTEXT).toBe('millwright / synth');
  });
});

describe('completePostSynth — the control-plane side of the trust boundary', () => {
  it('validates the model and writes the REG#/REF# registry entry', async () => {
    const h = harness({ 'runs/octocat/app/ci/7/in/model.json': modelJson() });
    const result = await completePostSynth(h.deps, { input: RUN_INPUT });

    expect(h.registryPuts).toHaveLength(1);
    const entry = h.registryPuts[0];
    expect({ pk: entry.pk, sk: entry.sk }).toEqual(
      registryKey('octocat/app', 'refs/heads/main'),
    );
    expect(entry.repo).toBe('octocat/app');
    expect(entry.ref).toBe('refs/heads/main');
    expect(entry.schemaVersion).toBe(1);
    expect(Object.keys(entry.workflows)).toEqual(['ci']);
    expect(entry.workflows.ci.triggers).toEqual([{ kind: 'push', branches: ['main'] }]);
    expect(entry.workflows.ci.concurrency).toEqual({ group: 'ci-${ref}', policy: 'queue' });
    // REG# rows are TTL-exempt configuration indexes (spec §8.3).
    expect(TTL_ATTRIBUTE in entry).toBe(false);

    expect(result.workflows).toEqual(['ci']);
  });

  it('reports the workflow-scoped synth check as successful, owned by the run', async () => {
    const h = harness({ 'runs/octocat/app/ci/7/in/model.json': modelJson() });
    await completePostSynth(h.deps, { input: RUN_INPUT });

    expect(h.checkPuts).toHaveLength(1);
    const check = h.checkPuts[0];
    expect({ pk: check.pk, sk: check.sk }).toEqual(
      checkStateKey('octocat/app', SHA, 'ci / synth'),
    );
    expect(check.context).toBe('ci / synth');
    expect(check.ownerRun).toBe('octocat/app#ci#7');
    expect(JSON.parse(check.desired!)).toMatchObject({ conclusion: 'success' });
    expect(check.expiresAt).toBeGreaterThan(NOW_MS / 1000);
  });

  it('bootstrap executions read the sha-keyed prefix and report millwright / synth with no owner run', async () => {
    const h = harness({ [`runs/octocat/app/.synth/${SHA}/in/model.json`]: modelJson() });
    await completePostSynth(h.deps, { input: BOOTSTRAP_INPUT });

    expect(h.reads).toEqual([`runs/octocat/app/.synth/${SHA}/in/model.json`]);
    expect(h.registryPuts).toHaveLength(1);
    expect(h.checkPuts[0].context).toBe('millwright / synth');
    expect(h.checkPuts[0].ownerRun).toBeUndefined();
  });

  it('is idempotent: identical inputs produce identical writes', async () => {
    const first = harness({ [`runs/octocat/app/.synth/${SHA}/in/model.json`]: modelJson() });
    const second = harness({ [`runs/octocat/app/.synth/${SHA}/in/model.json`]: modelJson() });
    await completePostSynth(first.deps, { input: BOOTSTRAP_INPUT });
    await completePostSynth(second.deps, { input: BOOTSTRAP_INPUT });
    expect(first.registryPuts).toEqual(second.registryPuts);
    expect(first.checkPuts).toEqual(second.checkPuts);
  });

  it('a missing model fails the step and reports the failure in the synth check', async () => {
    const h = harness({});
    await expect(completePostSynth(h.deps, { input: RUN_INPUT })).rejects.toThrowError(
      PostSynthError,
    );
    expect(h.registryPuts).toHaveLength(0);
    expect(h.checkPuts).toHaveLength(1);
    const desired = JSON.parse(h.checkPuts[0].desired!);
    expect(desired.conclusion).toBe('failure');
    expect(desired.summary).toMatch(/model\.json/);
  });

  it('schema-invalid models never reach the registry, and the error is surfaced', async () => {
    const h = harness({
      'runs/octocat/app/ci/7/in/model.json': JSON.stringify({ schemaVersion: 1 }),
    });
    await expect(completePostSynth(h.deps, { input: RUN_INPUT })).rejects.toThrowError(
      PostSynthError,
    );
    expect(h.registryPuts).toHaveLength(0);
    expect(JSON.parse(h.checkPuts[0].desired!).conclusion).toBe('failure');
  });

  it('rejects a model whose schemaVersion is newer than the control plane supports', async () => {
    const model = { ...JSON.parse(modelJson()), schemaVersion: 99 };
    const h = harness({ 'runs/octocat/app/ci/7/in/model.json': JSON.stringify(model) });
    await expect(completePostSynth(h.deps, { input: RUN_INPUT })).rejects.toThrow(/schemaVersion/);
    expect(h.registryPuts).toHaveLength(0);
  });

  it('rejects a model claiming a different repo — the registry write is keyed by the EXECUTION identity', async () => {
    const h = harness({
      'runs/octocat/app/ci/7/in/model.json': modelJson({ repo: 'octocat/other' }),
    });
    await expect(completePostSynth(h.deps, { input: RUN_INPUT })).rejects.toThrow(/repo/);
    expect(h.registryPuts).toHaveLength(0);
  });

  it('rejects a model synthesized at a different commit', async () => {
    const h = harness({
      'runs/octocat/app/ci/7/in/model.json': modelJson({ commit: 'b'.repeat(40) }),
    });
    await expect(completePostSynth(h.deps, { input: RUN_INPUT })).rejects.toThrow(/commit/);
    expect(h.registryPuts).toHaveLength(0);
  });

  it('rejects unparseable model documents', async () => {
    const h = harness({ 'runs/octocat/app/ci/7/in/model.json': 'not json {' });
    await expect(completePostSynth(h.deps, { input: RUN_INPUT })).rejects.toThrowError(
      PostSynthError,
    );
    expect(h.registryPuts).toHaveLength(0);
  });
});
