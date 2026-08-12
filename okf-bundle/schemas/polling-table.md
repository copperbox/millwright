---
type: schema
title: Polling table (DynamoDB)
tags:
  - millwright
  - dynamodb
  - schema
  - polling
timestamp: 2026-08-12T21:26:25.199Z
---

A **separate** on-demand DynamoDB table from the [state table](state-table.md), holding only poller
bookkeeping.

Per-repo items:

- **Last-seen ref→sha map — compressed, required.** Not an optimization: the 400 KB item cap is a
  certainty on large-ref repos, and the map is read *and* written per repo per tick.
- Tier-2 **PR ETags**.
- Cron **`last-fired-minute`** entries — see [Cron and dispatch](../architecture/cron-and-dispatch.md).
- **Quarantine marker**.

Plus one **circuit-breaker item** for the deployment.

## Why it is separate

The state table is the CLI's source of truth and carries run history with a 90-day TTL; the polling
table is high-frequency control state written every tick regardless of activity. Splitting them
keeps poller write volume off the table that Streams-feeds the reporter, and keeps the CLI's
read model clean — **the CLI never queries the polling table.**

The launcher reading it is permitted, though after the source-conditioned bus policy it no longer
needs to.

Code: `packages/millwright-state/src/polling.ts`,
`packages/millwright-cdk/src/runtime/poller/ref-map.ts`, `store.ts`.

# Citations

[1] [Spec §9.4, §6.1](../../docs/specs/1-millwright-v1-implementable-specification.md)
