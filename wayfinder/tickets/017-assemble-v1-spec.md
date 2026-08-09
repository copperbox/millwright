---
id: "017"
title: Assemble the v1 spec
type: wayfinder:task
status: closed
assignee: dan
blocked-by: ["015", "016"]
---

## Question

Assemble the implementable millwright v1 spec — the map's destination — from the
resolutions of all closed tickets. Every core architecture decision is now locked
(job compute, polling, workflow definition, orchestration & state, secrets,
artifacts & caching, observability, local parity, repo auth, PR checks, runner
images, packaging & config); this ticket compiles them into one coherent,
build-ready document: component inventory, package layout, data stores and
schemas (DynamoDB single-table, SSM config plane, S3 layouts), IAM model
(boundaries, per-job roles, run-prefix grants), CLI command surface, and the
run-model schema. Resolve any small contradictions between ticket resolutions in
favor of the later decision, flagging anything that isn't small.

Blocked on [Concurrency semantics](015-concurrency-semantics.md) and
[SSH ls-refs spike](016-ssh-ls-refs-spike.md) — the last two open decisions the
spec must fold in.

**Delivery**: publish the finished spec as a GitHub Discussion on this repo under
the **"AI Spec Council"** category (per Dan, 2026-08-08), in addition to linking
it from this ticket on resolution.

## Resolution

Assembled 2026-08-09 from the resolutions of tickets 001–016. The spec is
[`spec/millwright-v1.md`](../../spec/millwright-v1.md) (committed on `main`) and is
published as GitHub Discussion
[Millwright v1 — Implementable Specification (#1)](https://github.com/copperbox/millwright/discussions/1)
under the **AI Spec Council** category, per the delivery instruction.

Structure: framing invariants; component inventory (18 components); packaging &
config surface; workflow-definition API; run-model schema; polling; orchestration;
concurrency; data stores & schemas (DynamoDB single-table incl. GROUP/REG/CHECK
items, SSM config plane, S3 layouts); IAM model; job execution environment;
artifacts & caching; GitHub integration; local-parity contract; full CLI surface;
latency/cost table; then two audit sections.

**Contradiction handling** (per this ticket's brief): seven cross-ticket amendments
were reconciled in favor of the later decision and logged in the spec's §17
(HTTPS→SSH polling, Secrets Manager→SSM credential storage, key provisioning at
`repo add`, secrets path folded under the deployment prefix, the per-ref registry,
native CodeBuild cache dropped, check "queue" as desired-state reconciliation).
**None rose above small; no unresolved contradictions remain.** Spec-authored fills
no ticket decided are flagged in §18 — the only one warranting a build-time design
pass is the **per-run job-role lifecycle** (IAM role quota pressure); the rest are
naming/completeness fills (cron firing, dispatch transport, item/path names).

This was the map's terminus: with it closed, no open tickets remain and the
destination is reached.
