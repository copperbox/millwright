import { describe, expect, it } from 'vitest';
import {
  SynthBuildEvent,
  processSynthBuildEvent,
} from '../src/runtime/synth-events/synth-events';

function buildEvent(overrides: {
  status?: string;
  env?: Record<string, string>;
  project?: string;
}): SynthBuildEvent {
  const env = overrides.env ?? {
    MILLWRIGHT_TASK_TOKEN: 'tok-123',
    MILLWRIGHT_DEST_BUCKET: 'millwright-artifacts',
    MILLWRIGHT_DEST_PREFIX: 'runs/octocat/app/ci/7/in/',
  };
  return {
    source: 'aws.codebuild',
    'detail-type': 'CodeBuild Build State Change',
    detail: {
      'build-status': overrides.status ?? 'SUCCEEDED',
      'build-id': `arn:aws:codebuild:eu-west-1:1234:build/${overrides.project ?? 'millwright-builds'}:uuid`,
      'project-name': overrides.project ?? 'millwright-builds',
      'additional-information': {
        environment: {
          'environment-variables': Object.entries(env).map(([name, value]) => ({
            name,
            value,
            type: name === 'MILLWRIGHT_DEPLOY_KEY' ? 'PARAMETER_STORE' : 'PLAINTEXT',
          })),
        },
      },
    },
  };
}

interface Sent {
  kind: 'success' | 'failure';
  token: string;
  output?: string;
  error?: string;
  cause?: string;
}

function harness(overrides: { errorObject?: string; stale?: boolean } = {}) {
  const sent: Sent[] = [];
  const reads: string[] = [];
  return {
    sent,
    reads,
    deps: {
      sender: {
        sendSuccess: async (token: string, output: string) => {
          sent.push({ kind: 'success', token, output });
          return overrides.stale ? ('stale' as const) : ('sent' as const);
        },
        sendFailure: async (token: string, error: string, cause: string) => {
          sent.push({ kind: 'failure', token, error, cause });
          return overrides.stale ? ('stale' as const) : ('sent' as const);
        },
      },
      readObject: async (bucket: string, key: string) => {
        reads.push(`${bucket}/${key}`);
        return overrides.errorObject;
      },
      log: () => {},
    },
  };
}

describe('processSynthBuildEvent', () => {
  it('ignores builds without a synth task token — user jobs ride BUILD# mappings, not this path', async () => {
    const h = harness();
    const disposition = await processSynthBuildEvent(h.deps, buildEvent({ env: { OTHER: 'x' } }));
    expect(disposition).toBe('ignored');
    expect(h.sent).toHaveLength(0);
  });

  it('ignores non-terminal states', async () => {
    const h = harness();
    expect(await processSynthBuildEvent(h.deps, buildEvent({ status: 'IN_PROGRESS' }))).toBe(
      'ignored',
    );
    expect(h.sent).toHaveLength(0);
  });

  it('completes the token on SUCCEEDED with the build identity as output', async () => {
    const h = harness();
    const disposition = await processSynthBuildEvent(h.deps, buildEvent({}));
    expect(disposition).toBe('completed');
    expect(h.sent).toEqual([
      expect.objectContaining({ kind: 'success', token: 'tok-123' }),
    ]);
    expect(JSON.parse(h.sent[0].output!)).toMatchObject({
      buildId: 'millwright-builds:uuid',
    });
  });

  it('fails the token on FAILED, surfacing synth-error.json when the job left one', async () => {
    const h = harness({
      errorObject: JSON.stringify({ message: 'synth failed — workflows.ts threw' }),
    });
    const disposition = await processSynthBuildEvent(h.deps, buildEvent({ status: 'FAILED' }));
    expect(disposition).toBe('failed');
    expect(h.reads).toEqual(['millwright-artifacts/runs/octocat/app/ci/7/in/synth-error.json']);
    expect(h.sent[0]).toMatchObject({
      kind: 'failure',
      token: 'tok-123',
      error: 'SynthJobFailed',
    });
    expect(h.sent[0].cause).toContain('workflows.ts threw');
  });

  it('falls back to a generic cause when no error object exists', async () => {
    const h = harness();
    await processSynthBuildEvent(h.deps, buildEvent({ status: 'TIMED_OUT' }));
    expect(h.sent[0].cause).toMatch(/TIMED_OUT/);
  });

  it('treats STOPPED and FAULT as failures too', async () => {
    for (const status of ['STOPPED', 'FAULT']) {
      const h = harness();
      expect(await processSynthBuildEvent(h.deps, buildEvent({ status }))).toBe('failed');
    }
  });

  it('reports stale tokens without throwing — the execution may already be gone', async () => {
    const h = harness({ stale: true });
    expect(await processSynthBuildEvent(h.deps, buildEvent({}))).toBe('stale-token');
  });

  it('truncates enormous synth error messages to a sane cause size', async () => {
    const h = harness({
      errorObject: JSON.stringify({ message: 'x'.repeat(50_000) }),
    });
    await processSynthBuildEvent(h.deps, buildEvent({ status: 'FAILED' }));
    expect(h.sent[0].cause!.length).toBeLessThanOrEqual(4096);
  });
});
