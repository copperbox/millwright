---
id: "017"
title: Assemble the v1 spec
type: wayfinder:task
status: open
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
