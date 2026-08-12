import {
  POLLER_EVENT_SOURCE,
  RegistryItem,
  ValidBusEvent,
  registryKey,
} from '@copperbox/millwright-state';
import { describe, expect, it } from 'vitest';
import {
  evaluateGroupKey,
  matchWorkflows,
  matchesRefPattern,
} from '../src/runtime/launcher/match';

const SHA = 'b'.repeat(40);

function registry(workflows: Record<string, unknown>): RegistryItem {
  return {
    ...registryKey('octocat/app', 'refs/heads/main'),
    repo: 'octocat/app',
    ref: 'refs/heads/main',
    schemaVersion: 1,
    workflows: workflows as RegistryItem['workflows'],
  };
}

function event(overrides: Partial<ValidBusEvent>): ValidBusEvent {
  return {
    source: POLLER_EVENT_SOURCE,
    kind: 'push',
    repo: 'octocat/app',
    ref: 'refs/heads/main',
    sha: SHA,
    ...overrides,
  };
}

describe('matchesRefPattern — the §12a dialect test table', () => {
  it.each([
    ['main', 'main', true],
    ['mainline', 'main', false], // anchored: no substring behavior
    ['main', 'mainline', false],
    ['release/1.2', 'release/*', true],
    ['release/1/2', 'release/*', true], // * crosses "/"
    ['release', 'release/*', false],
    ['v1.2.3', 'v*', true],
    ['v1.2.3', 'v1.2.4', false],
    ['a.b', 'a.b', true],
    ['aXb', 'a.b', false], // "." is literal, not regex
    ['anything', '*', true],
    ['refs/pull/7/head', '*', false], // full refs are structurally unmatchable
  ])('%s vs %s → %s', (shortRef, pattern, expected) => {
    expect(matchesRefPattern(shortRef, pattern)).toBe(expected);
  });
});

describe('matchWorkflows', () => {
  const workflows = {
    ci: { triggers: [{ kind: 'push' }] },
    docs: { triggers: [{ kind: 'push', branches: ['docs/*'] }] },
    release: { triggers: [{ kind: 'tag', pattern: 'v*' }] },
    preview: { triggers: [{ kind: 'pull_request' }] },
    nightly: { triggers: [{ kind: 'cron', expression: '0 3 * * *' }] },
    deploy: {
      triggers: [{ kind: 'manual', inputs: {} }],
      concurrency: { group: 'deploy-${ref}', policy: 'queue' },
    },
  };

  it('matches pushes against push triggers with branch globs', () => {
    const result = matchWorkflows(registry(workflows), event({}));
    expect(result.matched.map((m) => m.workflow)).toEqual(['ci']);
    const docs = matchWorkflows(
      registry(workflows),
      event({ ref: 'refs/heads/docs/typos' }),
    );
    expect(docs.matched.map((m) => m.workflow)).toEqual(['ci', 'docs']);
  });

  it('treats a new branch head like a push to that branch', () => {
    const result = matchWorkflows(
      registry(workflows),
      event({ kind: 'branch', ref: 'refs/heads/feature/x' }),
    );
    expect(result.matched.map((m) => m.workflow)).toEqual(['ci']);
  });

  it('matches tags, prs, cron and dispatch to their trigger kinds', () => {
    const reg = registry(workflows);
    expect(
      matchWorkflows(reg, event({ kind: 'tag', ref: 'refs/tags/v1.2' })).matched.map(
        (m) => m.workflow,
      ),
    ).toEqual(['release']);
    expect(
      matchWorkflows(reg, event({ kind: 'pr', ref: 'refs/pull/7/head' })).matched.map(
        (m) => m.workflow,
      ),
    ).toEqual(['preview']);
    expect(
      matchWorkflows(
        reg,
        event({ kind: 'cron', workflow: 'nightly', minute: '2026-08-12T03:00' }),
      ).matched.map((m) => m.workflow),
    ).toEqual(['nightly']);
    const dispatch = matchWorkflows(reg, event({ kind: 'dispatch', workflow: 'deploy' }));
    expect(dispatch.matched).toEqual([
      { workflow: 'deploy', concurrency: { group: 'deploy-${ref}', policy: 'queue' } },
    ]);
  });

  it('never matches a cron or dispatch to a workflow it does not name', () => {
    const reg = registry(workflows);
    expect(
      matchWorkflows(reg, event({ kind: 'dispatch', workflow: 'ci' })).matched,
    ).toEqual([]); // ci has no manual trigger
    expect(
      matchWorkflows(
        reg,
        event({ kind: 'cron', workflow: 'deploy', minute: '2026-08-12T03:00' }),
      ).matched,
    ).toEqual([]);
  });

  it('a tag never matches push triggers and vice versa', () => {
    const reg = registry({ ci: { triggers: [{ kind: 'push' }] } });
    expect(matchWorkflows(reg, event({ kind: 'tag', ref: 'refs/tags/main' })).matched).toEqual(
      [],
    );
  });

  it('skips and reports workflows whose registry entries cannot be interpreted', () => {
    const reg = registry({
      broken: { triggers: 'push' },
      badgate: { triggers: [{ kind: 'push' }], concurrency: { group: 42 } },
      ok: { triggers: [{ kind: 'push' }] },
    });
    const result = matchWorkflows(reg, event({}));
    expect(result.matched.map((m) => m.workflow)).toEqual(['ok']);
    expect(result.malformed).toEqual(['badgate', 'broken']);
  });
});

describe('evaluateGroupKey', () => {
  it('expands the four trigger-context tokens', () => {
    const expanded = evaluateGroupKey(
      '${repo}/${workflow}@${ref}:${event}',
      event({ ref: 'refs/heads/release/1.2' }),
      'deploy',
    );
    expect(expanded).toBe('octocat/app/deploy@release/1.2:push');
  });
});
