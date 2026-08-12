---
type: decision
title: Caught-timeout wake instead of task heartbeats
tags:
  - millwright
  - orchestration
  - stepfunctions
timestamp: 2026-08-12T21:23:26.580Z
---

The Step Functions token-wait uses **`TimeoutSeconds: 60` with a `Catch` on `States.Timeout`** that
routes back into the decider. It does **not** use `HeartbeatSeconds`, and **no component sends
`SendTaskHeartbeat`**.

## Why

A heartbeat requires a sender — some component that periodically proves the work is still alive.
Every candidate sender was worse than the alternative: it would need its own scheduler, its own
failure mode, and it would still not know the truth (CodeBuild does).

The caught timeout collapses three needs into one mechanism:

1. **Liveness** — the loop re-enters at least every 60 s regardless of what else happens.
2. **Reconciliation** — on re-entry the decider re-reads `BatchGetBuilds`, which is the
   [authoritative source](batchgetbuilds-authoritative.md) for terminal job state, so a missed
   notification self-corrects.
3. **Race coverage** — it catches completions that land *between token generations*, which a
   notification-only design would drop on the floor.

The build-events handler remains the low-latency wake; the timeout is the safety net beneath it.
Neither is trusted alone.

## Consequence

Because reconciliation happens on every entry, **wakes are idempotent** — the decider re-reads
`cancelRequested`, job states, and CodeBuild ground truth each time. Token senders can therefore be
best-effort and must **swallow `TaskTimedOut` and `InvalidToken`**: a stale token send is normal
operation, not an error to surface.

Do not add a heartbeat sender. It was considered and rejected by name.

## Related

- [Decider loop](../architecture/decider-loop.md)

# Citations

[1] [Spec §7.3](../../docs/specs/1-millwright-v1-implementable-specification.md)
