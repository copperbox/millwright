---
type: architecture
title: The per-ref registry
tags:
  - millwright
  - orchestration
  - dynamodb
  - launcher
timestamp: 2026-08-12T21:24:13.886Z
---

The launcher must decide *which workflows an event triggers* **before** any synth has run for that
event — synth is expensive and runs repo code. The per-ref registry is the index that makes this
possible.

Every successful synth's `(triggers, concurrency)` map is written to DynamoDB keyed by ref — **by
control-plane code after model validation**, never by the [synth job](synth-job.md) itself. The
launcher matches an event against its ref's entry, falling back to the **default branch's** map for
never-synthed refs.

## Bootstrap on registry miss

When an event arrives for a `(repo, ref)` with no registry entry *and* no default-branch fallback,
the launcher starts a **synth-only execution**, idempotently keyed by `(repo, ref, sha)`, then
**replays the original event** against the resulting map. The replayed run reuses the bootstrap's
stored model rather than re-synthing.

The bootstrap reports the `millwright / synth` check, so **a first push is visible, never silent**.

## Supporting rules

- **`REG#` rows are exempt from the 90-day TTL**: they are configuration indexes, not run history,
  and are refreshed by every successful synth.
- **`repo add` primes the registry**: after writing config and installing the deploy key, the CLI
  emits a `bootstrap` event (`source: millwright.cli`) for the default-branch head (resolved via
  `ls-refs` with the fresh key). Onboarding ends with a primed registry and a visible synth check;
  on an empty repo it prints that triggers activate on first push.
- **`doctor` fails — not warns** — when a configured repo shows polling activity but has no
  default-branch registry entry, naming the bootstrap remedy.

## Consequences to remember

- A **branch's config changes take effect from that branch's second run**. The first run for a
  changed `on:` uses whatever the registry already held.
- **A new branch's first push uses default-branch config.**

Both follow directly from "the registry is written *after* synth". They are expected behavior, and
users will report them as bugs.

# Citations

[1] [Spec §8.3](../../docs/specs/1-millwright-v1-implementable-specification.md)
