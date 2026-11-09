import {
  RegistryItem,
  TTL_ATTRIBUTE,
  checkStateKey,
  parseDesiredCheckState,
  registryKey,
  serializeDesiredCheckState,
} from '@copperbox/millwright-state';
import { Trigger, Workflow, WorkflowSet, synthesize } from '@copperbox/millwright-workflows';
import { describe, expect, it } from 'vitest';
import {
  DesiredCheckWrite,
  UnownedDesiredCheckWrite,
  desiredCheckUpsert,
  unownedDesiredCheckUpsert,
} from '../src/runtime/shared/checks';
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
  ci.job('lint', { steps: ['npm run lint'] });
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
  checkWrites: { write: DesiredCheckWrite; nowMs: number }[];
  bootstrapWrites: { write: UnownedDesiredCheckWrite; nowMs: number }[];
  reads: string[];
  /** Simulates a newer run owning the context: the ownership upsert drops. */
  ownedByNewerRun: boolean;
}

function harness(objects: Record<string, string>): Harness {
  const h: Harness = {
    registryPuts: [],
    checkWrites: [],
    bootstrapWrites: [],
    reads: [],
    ownedByNewerRun: false,
    deps: {
      config: { schemaCeiling: 1, metadataRetentionDays: 90 },
      readObject: async (key: string) => {
        h.reads.push(key);
        return objects[key];
      },
      store: {
        putRegistry: async (item: RegistryItem) => {
          h.registryPuts.push(item);
        },
        putDesiredCheck: async (write, nowMs) => {
          h.checkWrites.push({ write, nowMs });
          return !h.ownedByNewerRun;
        },
        putBootstrapCheck: async (write, nowMs) => {
          h.bootstrapWrites.push({ write, nowMs });
        },
      },
      now: () => NOW_MS,
      log: () => {},
    },
  };
  return h;
}

/**
 * The reporter's exact read path: the serialization the store would write
 * (`desiredCheckUpsert` / `unownedDesiredCheckUpsert`), parsed back with
 * `parseDesiredCheckState`. A state that does not survive this never posts.
 */
function reporterReads(write: DesiredCheckWrite | UnownedDesiredCheckWrite) {
  const input =
    'ownerRunNumber' in write
      ? desiredCheckUpsert('table', write, NOW_MS, 90)
      : unownedDesiredCheckUpsert('table', write, NOW_MS, 90);
  const stored = input.ExpressionAttributeValues![':desired'] as string;
  return parseDesiredCheckState(stored);
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

  it('bootstrap executions read the sha-keyed prefix and report millwright / synth with no owner run', async () => {
    const h = harness({ [`runs/octocat/app/.synth/${SHA}/in/model.json`]: modelJson() });
    await completePostSynth(h.deps, { input: BOOTSTRAP_INPUT });

    expect(h.reads).toEqual([`runs/octocat/app/.synth/${SHA}/in/model.json`]);
    expect(h.registryPuts).toHaveLength(1);
    expect(h.checkWrites).toEqual([]);
    expect(h.bootstrapWrites).toHaveLength(1);
    const { write, nowMs } = h.bootstrapWrites[0];
    expect(write).toMatchObject({ repo: 'octocat/app', sha: SHA, context: 'millwright / synth' });
    expect('ownerRun' in write).toBe(false);
    expect(nowMs).toBe(NOW_MS);
  });

  it('is idempotent: identical inputs produce identical writes', async () => {
    const first = harness({ [`runs/octocat/app/.synth/${SHA}/in/model.json`]: modelJson() });
    const second = harness({ [`runs/octocat/app/.synth/${SHA}/in/model.json`]: modelJson() });
    await completePostSynth(first.deps, { input: BOOTSTRAP_INPUT });
    await completePostSynth(second.deps, { input: BOOTSTRAP_INPUT });
    expect(first.registryPuts).toEqual(second.registryPuts);
    expect(first.bootstrapWrites).toEqual(second.bootstrapWrites);
    expect(serializeDesiredCheckState(first.bootstrapWrites[0].write.desired)).toBe(
      serializeDesiredCheckState(second.bootstrapWrites[0].write.desired),
    );
  });

  it('schema-invalid models never reach the registry, and the error is surfaced', async () => {
    const h = harness({
      'runs/octocat/app/ci/7/in/model.json': JSON.stringify({ schemaVersion: 1 }),
    });
    await expect(completePostSynth(h.deps, { input: RUN_INPUT })).rejects.toThrowError(
      PostSynthError,
    );
    expect(h.registryPuts).toHaveLength(0);
    expect(h.checkWrites[0].write.desired).toMatchObject({
      status: 'completed',
      conclusion: 'failure',
    });
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

describe('completePostSynth — the synth check (spec §13.2 lifecycle)', () => {
  it('completes the workflow-scoped synth check as a success owned by the run, counting its job checks', async () => {
    const h = harness({ 'runs/octocat/app/ci/7/in/model.json': modelJson() });
    await completePostSynth(h.deps, { input: RUN_INPUT });

    expect(h.bootstrapWrites).toEqual([]);
    expect(h.checkWrites).toHaveLength(1);
    const { write, nowMs } = h.checkWrites[0];
    expect(write).toMatchObject({
      repo: 'octocat/app',
      sha: SHA,
      context: 'ci / synth',
      ownerRun: 'ci#7',
      ownerRunNumber: 7,
    });
    expect(nowMs).toBe(NOW_MS);
    // The same item the launcher wrote `in_progress` under at run start.
    expect(desiredCheckUpsert('table', write, NOW_MS, 90).Key).toEqual(
      checkStateKey('octocat/app', SHA, 'ci / synth'),
    );

    const desired = reporterReads(write);
    expect(desired).toMatchObject({ status: 'completed', conclusion: 'success' });
    expect(desired.title).not.toBe('');
    expect(desired.summary).toContain('ci#7');
    expect(desired.summary).toContain('2 job check(s)');
  });

  it('a missing model fails the step and the failure, with its reason, survives the reporter read path', async () => {
    const h = harness({});
    await expect(completePostSynth(h.deps, { input: RUN_INPUT })).rejects.toThrowError(
      PostSynthError,
    );
    expect(h.registryPuts).toHaveLength(0);
    expect(h.checkWrites).toHaveLength(1);
    const desired = reporterReads(h.checkWrites[0].write);
    expect(desired).toMatchObject({ status: 'completed', conclusion: 'failure' });
    expect(desired.summary).toMatch(/model\.json/);
    expect(desired.summary).toContain('ci#7');
  });

  it('bootstrap outcomes survive the reporter read path too, naming the sha', async () => {
    const ok = harness({ [`runs/octocat/app/.synth/${SHA}/in/model.json`]: modelJson() });
    await completePostSynth(ok.deps, { input: BOOTSTRAP_INPUT });
    const succeeded = reporterReads(ok.bootstrapWrites[0].write);
    expect(succeeded).toMatchObject({ status: 'completed', conclusion: 'success' });
    expect(succeeded.summary).toContain(SHA.slice(0, 12));

    const broken = harness({
      [`runs/octocat/app/.synth/${SHA}/in/model.json`]: JSON.stringify({ schemaVersion: 1 }),
    });
    await expect(completePostSynth(broken.deps, { input: BOOTSTRAP_INPUT })).rejects.toThrow();
    const failed = reporterReads(broken.bootstrapWrites[0].write);
    expect(failed).toMatchObject({ status: 'completed', conclusion: 'failure' });
    expect(failed.summary).toMatch(/Invalid run model/);
  });

  it('a synth check owned by a newer run is dropped without failing the step', async () => {
    const h = harness({ 'runs/octocat/app/ci/7/in/model.json': modelJson() });
    h.ownedByNewerRun = true;
    const logged: string[] = [];
    h.deps = { ...h.deps, log: (message) => logged.push(message) };
    await expect(completePostSynth(h.deps, { input: RUN_INPUT })).resolves.toBeDefined();
    expect(h.registryPuts).toHaveLength(1);
    expect(logged).toContain('synth check owned by a newer run; not updated');
  });

  it('a check write failure never masks the original synth error', async () => {
    const h = harness({});
    h.deps = {
      ...h.deps,
      store: {
        ...h.deps.store,
        putDesiredCheck: async () => {
          throw new Error('table unavailable');
        },
      },
    };
    await expect(completePostSynth(h.deps, { input: RUN_INPUT })).rejects.toThrow(/model\.json/);
  });
});
