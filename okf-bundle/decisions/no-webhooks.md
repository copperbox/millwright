---
type: decision
title: Why polling instead of webhooks
tags:
  - millwright
  - polling
  - resilience
timestamp: 2026-08-12T21:22:25.664Z
---

Millwright has **no webhook dependency**, by design and permanently in v1. Webhook-*dependent*
triggering is out of scope, not deferred.

## Rationale

- A webhook receiver is an inbound public endpoint that must be highly available, authenticated,
  and replay-safe. Polling needs none of that: nothing inbound, no shared secret to rotate, no
  delivery backlog to reconcile.
- The resilient core ([tier 1](../architecture/polling.md)) speaks the **git protocol over SSH**,
  which stays up when GitHub's REST API, Actions, and webhook delivery are degraded. Triggering
  survives incidents that take GitHub Actions itself offline — that is the product claim.
- Polling makes trigger state *reconcilable*: the poller diffs observed refs against stored refs,
  so a missed tick self-heals on the next one. A missed webhook is gone.

## The cost, accepted

Detection latency of ~30–90 s typical, ~2 min worst case, versus a webhook's near-instant delivery.
This is stated as a product property, not hidden. See
[Cost and latency](../operations/cost-and-latency.md).

Cron granularity is also bound to the poll cadence, since the tick *is* the cron clock — see
[Cron and manual dispatch](../architecture/cron-and-dispatch.md).

## The escape hatch, deferred

An **opportunistic webhook fast-path** is on the deferred list: it would shorten latency and would
carry check-run re-run buttons (requested actions are webhook-delivered). Crucially it would be
*opportunistic* — an accelerator over a polling core that still works without it, never a
dependency. See [Deferred and out of scope](../deferred-and-out-of-scope.md).

# Citations

[1] [Spec §1, §6, §19](../../docs/specs/1-millwright-v1-implementable-specification.md)
