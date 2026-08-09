---
id: "015"
title: Concurrency semantics
type: wayfinder:grilling
status: closed
assignee: dan
blocked-by: ["006"]
---

## Question

What are millwright's concurrency semantics — max concurrent runs per workflow,
concurrency groups (e.g. one deploy at a time per environment), queue-vs-reject when
the limit is hit, and cancel-superseded-runs (a newer push cancels the older in-flight
run for the same ref)?

Graduated from fog by [Orchestration and state model](006-orchestration-state-model.md),
which fixed the enforcement point: the **launcher Lambda** sees every run before
`StartExecution` and owns the run records, so gating/queueing/superseding decisions are
made there against the state table. Cancel-superseded can reuse the decided cancellation
path (`cancelRequested` + task-token wake) unchanged. To decide: the definition-API
surface (`concurrency` on Workflow?), default limits, queueing order, and whether
CodeBuild's own account-level concurrency quota needs surfacing to the user.

## Resolution

Decided live with Dan (2026-08-09). **Opt-in concurrency groups, enforced by the
launcher against a synth-written per-ref registry.**

**Pre-synth config visibility (amends [Orchestration and state
model](006-orchestration-state-model.md) and [Workflow-definition construct
API](004-workflow-definition-api.md)).** Grilling exposed an unrecorded gap: the
launcher must match events → workflows and gate concurrency *before* the run's synth
job exists, yet the definition lives at the triggering commit. Fix: **every successful
synth writes the repo's trigger + concurrency map to DynamoDB keyed by ref**; the
launcher matches an event against its ref's entry, falling back to the default
branch's map for never-synthed refs. Branch config changes take effect from that
branch's second run; a new branch's first push uses default-branch config. This
registry is also the previously-unstated mechanism by which the launcher knows which
workflows an event triggers at all.

**Primitive.** `concurrency` groups are the single primitive; membership in a group
means **at most one run executes at a time**. No group declared → unlimited concurrent
runs. No numeric limits in v1 (fog; the group item can carry a count later without
reshaping the API).

**Policies (per group).** `queue` (default): the new run waits, loss-free for
deploy-style groups. `supersede` (opt-in): the new run cancels the in-flight run via
the decided `cancelRequested` + task-token path, unchanged. No `reject` policy.

**Queue depth: pending slot of one** (GHA-style). A group holds at most one waiting
run; a newer arrival replaces it. Replaced-pending and superseded-in-flight runs are
**CANCELLED with `reason: superseded`** — the run-status algebra stays closed; the CLI
renders the reason. Full FIFO went to fog. Superseded runs are rerunnable
(`runs rerun` creates a fresh run that joins the group normally).

**Group keys.** Static strings plus a **closed set of trigger-context tokens** —
ref, workflow, repo, event — evaluable by the launcher pre-synth; nothing
model-derived. Scope is **deployment-global** (a repo-spanning `deploy-prod` lock is
free and GHA can't do it); include `${repo}` in the key for repo-local behavior —
docs convention, candidate lint.

**Uniform gating.** Poll, cron, `dispatch`, and `rerun` all gate identically at the
launcher; **no bypass flag** (fog). Break-glass is explicit: cancel the in-flight run,
which frees the group.

**Local runner.** `millwright run` carries concurrency config in the model but does
not enforce it (zero-AWS-calls property; groups are a property of the deployment's
orchestration, not the workflow's execution). One-line doc.

**CodeBuild account quota: surface, don't manage.** `millwright doctor` reports the
account's concurrent-build quotas (Service Quotas API) against the deployment's
plausible fan-out and points at the increase request; docs state that beyond-quota
builds queue at AWS (spike measured 30–40 s bursts), they don't fail. No
millwright-side throttle.

**Mechanics sketch** (detail belongs to the spec): a `GROUP#<key>` item in the state
table holds the running and pending run ids; the launcher claims or replaces the
pending slot with conditional/transactional writes (run records for queued runs are
created at queue time, marked QUEUED); on run completion the decider clears the
running slot and starts the pending run's execution, with the existing reconciliation
sweep as crash-safety.
