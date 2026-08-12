---
type: operations
title: Degradation, quarantine, and the sweep
tags:
  - millwright
  - operations
  - resilience
  - polling
timestamp: 2026-08-12T21:28:14.744Z
---

## Polling degradation

- **Quorum circuit breaker**: when **≥3 repos'** SSH transports fail, the breaker opens — the signal
  is treated as "GitHub or our egress is broken", not "these repos are broken". A decaying canary
  probes for recovery.
- **Per-repo quarantine** on "Repository not found" or key-auth rejection. One misconfigured repo
  must not consume the tick budget or trip the quorum breaker.
- **Backoff with jitter** on tier-2 API errors.

The distinction matters: the breaker protects against *systemic* failure, quarantine against
*individual* failure. Conflating them either quarantines everything during a GitHub incident or
lets one dead repo look like an outage.

Code: `packages/millwright-cdk/src/runtime/poller/degradation.ts`.

## Poller overlap

Reserved concurrency 1 plus a Lambda timeout ≥ 2× `pollCadence` means a tick firing while the
previous one runs is **self-throttled**. There is a counter and alarm on sustained overlap, and
`doctor` reports last-tick duration. Sustained overlap is the signal to shard the schedule
(documented growth path past N≈100 repos, not built).

## The sweep (C16), every minute

- **Concurrency-group crash safety** — detects groups whose running run is terminal but whose slot
  never cleared, and starts the pending run. It repairs *slots*; it never resurrects executions.
- **Stale job-role housekeeping** — deletes role pairs whose `(workflow, job)` no longer appears in
  any registry entry after 30 days.

Check reconciliation is **not** the sweep's — it belongs to the reporter alone, which has its own
1-minute sweep path. See [Check reporting](../architecture/check-reporting.md).

## Run-level safety nets

A stuck run dies a **managed** death via the per-job attempt cap (3) and the run-level 24 h
deadline — see [Decider loop](../architecture/decider-loop.md). `StopExecution` is documented
break-glass only.

# Citations

[1] [Spec §6.3, §8.4, §10.2, §13.2](../../docs/specs/1-millwright-v1-implementable-specification.md)
[2] [Operating a deployment](../../docs/operations.md)
