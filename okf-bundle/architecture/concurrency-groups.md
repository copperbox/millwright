---
type: architecture
title: Concurrency groups
tags:
  - millwright
  - concurrency
  - orchestration
timestamp: 2026-08-12T21:24:04.075Z
---

Opt-in concurrency groups. Membership means **at most one run executes at a time**. No group
declared → unlimited concurrent runs. **No numeric limits in v1.**

```ts
concurrency: { group: 'deploy-${repo}', policy: 'queue' | 'supersede' }
```

## Keys and policies

- Keys are static strings plus `${ref}` / `${workflow}` / `${repo}` / `${event}` tokens —
  deliberately **launcher-evaluable pre-synth**, so gating happens before any repo code runs.
- Scope is **deployment-global**.
- Policies: `queue` (default) and `supersede`. Pending slot of exactly **one**.
- Superseded/replaced runs are CANCELLED with `reason: superseded`, and remain rerunnable.
- Gating is **uniform** across poll / cron / dispatch / rerun. **There is no bypass flag.**
- Local runs don't enforce groups (the definition is carried, not applied).
- CodeBuild's account concurrency quota is *surfaced* by `doctor`, not managed by millwright.

## Mechanics

A `GROUP#<key>` item holds the running and pending run ids. The launcher claims or replaces the
pending slot with conditional/transactional writes — queued runs' records already exist at queue
time, in QUEUED state.

On run completion the decider clears the running slot and starts the pending run. Both the decider
and the sweep hold `states:StartExecution`.

**Crash safety**: the [sweep](../operations/degradation.md) detects groups whose running run is
terminal but whose slot never cleared, and starts the pending run. The sweep repairs *slots*; it
never resurrects executions.

Code: `packages/millwright-cdk/src/runtime/shared/groups.ts`,
`packages/millwright-cdk/src/runtime/sweep/`.

# Citations

[1] [Spec §8.1, §8.2, §8.4](../../docs/specs/1-millwright-v1-implementable-specification.md)
