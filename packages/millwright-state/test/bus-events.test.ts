import { describe, expect, it } from 'vitest';
import {
  CLI_EVENT_SOURCE,
  POLLER_EVENT_SOURCE,
  STEP_EVENT_SOURCE,
  shortRefName,
  validateBusEvent,
} from '../src';

const SHA = 'a'.repeat(40);

const push = {
  repo: 'octocat/app',
  ref: 'refs/heads/main',
  sha: SHA,
  defaultBranch: 'main',
};

describe('validateBusEvent — source binding', () => {
  it('accepts push/branch/tag/pr only from the poller', () => {
    for (const kind of ['push', 'branch', 'tag', 'pr'] as const) {
      const ref =
        kind === 'tag' ? 'refs/tags/v1' : kind === 'pr' ? 'refs/pull/7/head' : push.ref;
      expect(validateBusEvent(POLLER_EVENT_SOURCE, kind, { ...push, ref }).ok).toBe(true);
      expect(validateBusEvent(CLI_EVENT_SOURCE, kind, { ...push, ref }).ok).toBe(false);
      expect(validateBusEvent(STEP_EVENT_SOURCE, kind, { ...push, ref }).ok).toBe(false);
    }
  });

  it('rejects a forged push from millwright.cli with a reason naming the required source', () => {
    const result = validateBusEvent(CLI_EVENT_SOURCE, 'push', push);
    expect(result).toMatchObject({ ok: false, reason: expect.stringContaining('poller') });
  });

  it('accepts dispatch/bootstrap only from the CLI', () => {
    const bootstrap = { repo: 'octocat/app', ref: 'refs/heads/main', sha: SHA };
    expect(validateBusEvent(CLI_EVENT_SOURCE, 'bootstrap', bootstrap).ok).toBe(true);
    expect(validateBusEvent(POLLER_EVENT_SOURCE, 'bootstrap', bootstrap).ok).toBe(false);
    const dispatch = { ...bootstrap, workflow: 'ci' };
    expect(validateBusEvent(CLI_EVENT_SOURCE, 'dispatch', dispatch).ok).toBe(true);
    expect(validateBusEvent(POLLER_EVENT_SOURCE, 'dispatch', dispatch).ok).toBe(false);
  });

  it('rejects unknown kinds and unknown sources', () => {
    expect(validateBusEvent(POLLER_EVENT_SOURCE, 'merge', push).ok).toBe(false);
    expect(validateBusEvent('millwright.step', 'push', push).ok).toBe(false);
    expect(validateBusEvent('aws.codebuild', 'push', push).ok).toBe(false);
  });
});

describe('validateBusEvent — shape', () => {
  it('normalizes a valid push', () => {
    const result = validateBusEvent(POLLER_EVENT_SOURCE, 'push', {
      ...push,
      sha: SHA.toUpperCase(),
      kind: 'push',
    });
    expect(result).toEqual({
      ok: true,
      event: {
        source: POLLER_EVENT_SOURCE,
        kind: 'push',
        repo: 'octocat/app',
        ref: 'refs/heads/main',
        sha: SHA,
        defaultBranch: 'main',
        workflow: undefined,
        minute: undefined,
        inputs: undefined,
      },
    });
  });

  it('rejects malformed repos, shas, and refs', () => {
    expect(validateBusEvent(POLLER_EVENT_SOURCE, 'push', { ...push, repo: 'app' }).ok).toBe(false);
    expect(validateBusEvent(POLLER_EVENT_SOURCE, 'push', { ...push, repo: 'a#b/c' }).ok).toBe(
      false,
    );
    expect(validateBusEvent(POLLER_EVENT_SOURCE, 'push', { ...push, sha: 'abc123' }).ok).toBe(
      false,
    );
    expect(validateBusEvent(POLLER_EVENT_SOURCE, 'push', { ...push, ref: 'main' }).ok).toBe(false);
    expect(
      validateBusEvent(POLLER_EVENT_SOURCE, 'push', { ...push, ref: 'refs/tags/v1' }).ok,
    ).toBe(false);
    expect(validateBusEvent(POLLER_EVENT_SOURCE, 'push', null).ok).toBe(false);
  });

  it('rejects a detail.kind that contradicts the detail-type', () => {
    expect(validateBusEvent(POLLER_EVENT_SOURCE, 'push', { ...push, kind: 'tag' }).ok).toBe(false);
  });

  it('requires workflow and minute on cron events', () => {
    const cron = { ...push, workflow: 'nightly', minute: '2026-08-12T06:03' };
    expect(validateBusEvent(POLLER_EVENT_SOURCE, 'cron', cron).ok).toBe(true);
    expect(validateBusEvent(POLLER_EVENT_SOURCE, 'cron', { ...cron, workflow: undefined }).ok).toBe(
      false,
    );
    expect(validateBusEvent(POLLER_EVENT_SOURCE, 'cron', { ...cron, minute: 'today' }).ok).toBe(
      false,
    );
  });

  it('accepts dispatch to any ref namespace with typed inputs', () => {
    const result = validateBusEvent(CLI_EVENT_SOURCE, 'dispatch', {
      repo: 'octocat/app',
      ref: 'refs/tags/v1.2',
      sha: SHA,
      workflow: 'release',
      inputs: { env: 'prod', dryRun: false },
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.event.inputs).toEqual({ env: 'prod', dryRun: false });
    }
    expect(
      validateBusEvent(CLI_EVENT_SOURCE, 'dispatch', {
        ...push,
        workflow: 'release',
        inputs: { n: 3 },
      }).ok,
    ).toBe(false);
  });

  it('rejects a full ref in defaultBranch', () => {
    expect(
      validateBusEvent(POLLER_EVENT_SOURCE, 'push', { ...push, defaultBranch: 'refs/heads/main' })
        .ok,
    ).toBe(false);
  });

  it('accepts a rerun only from the CLI, requiring workflow, source run and nonce', () => {
    const rerun = {
      repo: 'octocat/app',
      ref: 'refs/heads/main',
      sha: SHA,
      workflow: 'ci',
      sourceRunNumber: 41,
      nonce: 'f00d'.repeat(8),
    };
    const result = validateBusEvent(CLI_EVENT_SOURCE, 'rerun', rerun);
    expect(result).toEqual({
      ok: true,
      event: expect.objectContaining({
        kind: 'rerun',
        workflow: 'ci',
        sourceRunNumber: 41,
        failedOnly: false,
        nonce: rerun.nonce,
      }),
    });
    expect(validateBusEvent(POLLER_EVENT_SOURCE, 'rerun', rerun).ok).toBe(false);
    expect(validateBusEvent(CLI_EVENT_SOURCE, 'rerun', { ...rerun, workflow: undefined }).ok).toBe(
      false,
    );
    expect(
      validateBusEvent(CLI_EVENT_SOURCE, 'rerun', { ...rerun, sourceRunNumber: 0 }).ok,
    ).toBe(false);
    expect(
      validateBusEvent(CLI_EVENT_SOURCE, 'rerun', { ...rerun, sourceRunNumber: '41' }).ok,
    ).toBe(false);
    expect(validateBusEvent(CLI_EVENT_SOURCE, 'rerun', { ...rerun, nonce: undefined }).ok).toBe(
      false,
    );
    expect(validateBusEvent(CLI_EVENT_SOURCE, 'rerun', { ...rerun, nonce: 'a#b' }).ok).toBe(false);
  });

  it('carries failedOnly on a rerun and accepts any ref namespace', () => {
    const result = validateBusEvent(CLI_EVENT_SOURCE, 'rerun', {
      repo: 'octocat/app',
      ref: 'refs/pull/7/head',
      sha: SHA,
      workflow: 'ci',
      sourceRunNumber: 41,
      failedOnly: true,
      nonce: 'abc123',
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.event.failedOnly).toBe(true);
      expect(result.event.ref).toBe('refs/pull/7/head');
    }
    expect(
      validateBusEvent(CLI_EVENT_SOURCE, 'rerun', {
        repo: 'octocat/app',
        ref: 'refs/heads/main',
        sha: SHA,
        workflow: 'ci',
        sourceRunNumber: 41,
        failedOnly: 'yes',
        nonce: 'abc123',
      }).ok,
    ).toBe(false);
  });

  it('accepts the exact bootstrap detail the CLI emits on repo add', () => {
    // Pinned by the reporting-and-cli consist: { repo, ref, sha, kind }.
    const result = validateBusEvent(CLI_EVENT_SOURCE, 'bootstrap', {
      repo: 'octocat/app',
      ref: 'refs/heads/main',
      sha: SHA,
      kind: 'bootstrap',
    });
    expect(result.ok).toBe(true);
  });
});

describe('shortRefName', () => {
  it('strips branch and tag prefixes and leaves other namespaces whole', () => {
    expect(shortRefName('refs/heads/release/1.2')).toBe('release/1.2');
    expect(shortRefName('refs/tags/v1')).toBe('v1');
    expect(shortRefName('refs/pull/7/head')).toBe('refs/pull/7/head');
  });
});
