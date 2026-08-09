---
id: "015"
title: Concurrency semantics
type: wayfinder:grilling
status: open
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
