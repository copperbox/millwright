---
type: architecture
title: Polling architecture
tags:
  - millwright
  - polling
  - github
  - resilience
timestamp: 2026-08-12T21:22:08.681Z
---

Triggering is poll-driven in **two tiers of deliberately different reliability**. The split is the
point: the resilient core keeps working when GitHub's REST API, Actions, and webhooks are down.

## Tier 1 — git protocol over SSH (resilient core)

Covers push / branch / tag. EventBridge Scheduler (1-min rate + jitter) → the non-VPC poller Lambda.

- **Transport: pure-JS `ssh2`**, exec `git-upload-pack 'owner/repo'` with `GIT_PROTOCOL=version=2`,
  authenticated with the repo's **read-only deploy key**. Implemented in
  `packages/millwright-cdk/src/runtime/poller/git/`.
- Detect protocol fallback by the first pkt-line: without the env var, babeld streams the v0
  advertisement — fat but correct; parse it anyway.
- **Scaling is by ref count, not repo count.** The operating query is the full
  `refs/heads/*` + `refs/tags/*` namespace at ~65 B/ref — hundreds of KB per tick on a 5,000-ref
  repo. Protocol v2 removes the capability advertisement and peeled-tag duplication, not the per-ref
  payload. The "67 B" figure from the early spike was a *single-ref best case*; do not quote it as
  the operating number.
- **Fan-out**: bounded intra-tick concurrency of 8–10 parallel `ssh2` sessions (I/O-dominated;
  50 repos ≈ 7–8 s/tick). Poller reserved concurrency = 1 and Lambda timeout ≥ 2× `pollCadence`, so
  a tick firing while the previous one runs is **self-throttled**. `doctor` reports last-tick
  duration. Growth path past N≈100 repos is schedule sharding by repo prefix — documented, not built.
- **Ref-map compression is required v1 behavior**, not an optimization: the 400 KB DynamoDB item cap
  is a certainty on large-ref repos, and the map is read+written per repo per tick.
- **Deploy keys always** — the everyday path *is* the outage path. The App token never touches
  tier 1. See [GitHub auth](../security/github-auth.md).
- **Host keys** are pinned from GitHub's `/meta` into SSM at setup, with compiled-in published
  fingerprints as day-one defaults; auto-reconcile-with-alarm on confirmed rotation, hard-fail
  otherwise. `millwright refresh-host-keys` is the manual hatch. The same pins serve the synth
  job's clone.
- **Default-branch discovery** is free: the `symrefs` HEAD answer is already in every `ls-refs`
  exchange.

Ordering is [emit-then-commit](emit-then-commit.md).

## Tier 2 — PR polling (best-effort)

`GET /repos/{o}/{r}/pulls?state=all&sort=updated` with per-repo ETags, App-token authenticated
(needs the App's **Pull requests: read** permission). Authenticated 304s don't count against the
primary rate limit. 50 repos at 1-min polls ≈ 3,000 req/hr worst case, inside the 5,000/hr budget.
Cadence band 60–120 s; per-repo `prPolling` toggle in repo config.

This tier degrades when the API degrades. That is accepted and explicit, not a bug.

## Degradation

See [Degradation and quarantine](../operations/degradation.md).

## Related

- [Non-VPC poller](../decisions/non-vpc-poller.md) — why NAT is refused.
- [Cron and manual dispatch](cron-and-dispatch.md) — the tick doubles as the cron clock.
- [Polling table](../schemas/polling-table.md).

# Citations

[1] [Spec §6 — triggering: polling architecture](../../docs/specs/1-millwright-v1-implementable-specification.md)
