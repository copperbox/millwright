---
type: architecture
title: Run start — the launcher sequence
tags:
  - millwright
  - orchestration
  - launcher
timestamp: 2026-08-12T21:22:48.886Z
---

EventBridge rule → **launcher Lambda**. The order of these steps is pinned, not incidental:
validation strictly precedes the dedupe write.

1. **Validate source and shape.** The bus resource policy restricts `PutEvents` by principal **and
   `events:source`**: poller role → `millwright.poller` only; operator CLI → `millwright.cli` only;
   job roles → `millwright.step` only. The launcher then accepts `push`/`branch`/`tag` only from
   `millwright.poller`, and `dispatch`/`bootstrap` only from `millwright.cli`. **Event source is
   part of trigger matching, not decoration** — a forged push requires the poller role's own
   credentials.
2. **Dedupe** on the content-derived key `EVENT#<repo>#<ref>#<sha>#<kind>`, conditional put,
   **TTL 30 minutes**. The item is a *processing record*: the run id is written onto it once the run
   exists, so launcher retries resume idempotently instead of dropping the event.
3. **Match** event → workflows via the [per-ref registry](per-ref-registry.md); on a registry miss
   with no default-branch fallback, start a bootstrap synth-only execution and replay.
4. **Increment the per-workflow run counter** atomically → workflow-scoped run number (`ci#142`).
5. **Write the run record** (PENDING).
6. **Gate concurrency** — the run proceeds, or is marked **QUEUED in place**. See
   [Concurrency groups](concurrency-groups.md).
7. `StartExecution` on the run executor.

## Accepted blind spot

A force-push **revert** to a sha already seen within the past 30 minutes coalesces into the earlier
run. This is documented and accepted, not a defect to fix opportunistically — narrowing the TTL
trades it for duplicate runs in the ordinary crash window (see
[emit-then-commit](emit-then-commit.md)).

## Also owned by the launcher

Rerun artifact prefix-copy — see [Status algebra](status-algebra.md#rerun) and
[S3 layout](../schemas/s3-layout.md). The launcher role carries the S3 copy grants precisely
because this step is its own.

Code: `packages/millwright-cdk/src/runtime/launcher/`.

# Citations

[1] [Spec §7.1](../../docs/specs/1-millwright-v1-implementable-specification.md)
