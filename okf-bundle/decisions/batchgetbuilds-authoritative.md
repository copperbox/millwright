---
type: decision
title: BatchGetBuilds is authoritative for terminal job state
tags:
  - millwright
  - orchestration
  - codebuild
  - security
timestamp: 2026-08-12T21:23:37.312Z
---

The decider treats **CodeBuild's `BatchGetBuilds` as the authority** for whether a job reached a
terminal state. The job rows in the state table are a **projection**, not the truth.

## Why

Job rows are written by the build-events handler off an EventBridge stream. If a row could decide
outcomes, then anything that could corrupt a row could flip a failing job green. Anchoring terminal
authority in CodeBuild's own API means **a poisoned row can never flip a failing sibling green** —
the worst it can do is misrender in the UI.

This is the same principle that makes step rows display-only: see
[Writer partitioning](../architecture/writer-partitioning.md).

## Consequences

- The decider re-reads `BatchGetBuilds` on **every** loop entry, which is what makes wakes
  idempotent and lets the [caught-timeout wake](no-heartbeat-wake.md) work as a safety net.
- Job rows can lag or be missing without correctness impact; reconciliation is automatic.
- `runs show` reads rows, so display can briefly disagree with truth. That's acceptable by
  construction.

## Related

- [Decider loop](../architecture/decider-loop.md)
- [State table](../schemas/state-table.md)

# Citations

[1] [Spec §7.3, §7.8](../../docs/specs/1-millwright-v1-implementable-specification.md)
