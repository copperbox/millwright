---
type: decision
title: Emit-then-commit ref diffing
tags:
  - millwright
  - polling
  - correctness
timestamp: 2026-08-12T21:22:15.837Z
---

The poller **emits diff events to the bus first, then commits the new ref→sha map** to the polling
table.

## Why

Commit-then-emit is ruled out **by name**: if the poller crashes between the commit and the emit,
the pushes in that diff are silently lost forever — there is no later tick that will rediscover
them, because the committed map already claims they were seen. A silently dropped push is the worst
failure mode this system can have.

Emit-then-commit inverts the crash window into duplicates instead of losses, and duplicates are
already handled: the launcher dedupes on the content-derived key
`EVENT#<repo>#<ref>#<sha>#<kind>` with a 30-minute TTL. See [Run start](run-start.md).

## The rule

Prefer *at-least-once with a dedupe* over *at-most-once*, anywhere a lost trigger would be
invisible. This is why the dedupe item is a **processing record** (the run id is written onto it
once created) rather than a bare marker — launcher retries resume idempotently instead of dropping
the event.

## Related

- [Polling architecture](polling.md)
- [Polling table](../schemas/polling-table.md)

# Citations

[1] [Spec §6.1, §7.1](../../docs/specs/1-millwright-v1-implementable-specification.md)
