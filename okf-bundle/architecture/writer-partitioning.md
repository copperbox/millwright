---
type: architecture
title: Writer partitioning of the state table
tags:
  - millwright
  - security
  - dynamodb
  - orchestration
timestamp: 2026-08-12T21:23:55.662Z
---

Every item class in the [state table](../schemas/state-table.md) has **exactly one writer**. This is
mechanically true, not a convention — the IAM policies enforce it.

| Writer | Writes |
|---|---|
| **Launcher** | run counter, run create, dedupe/processing records, concurrency-group claims, rerun prefix-copy |
| **Decider** | run + job rows, group hand-off, check desired-state, `BUILD#` items |
| **Step-events writer (C19)** | step rows only |
| **Reporter** | check *reported*-state only |
| **CLI (operator IAM)** | `cancelRequested` + task-token send |

**Job roles have no DynamoDB access at all.** Not read, not write — an explicit negative.

## Why it matters

Jobs run repo-controlled code. If a job could write the table, it could rewrite its own outcome,
forge another run's state, or overwrite the registry. Removing table access entirely means the
question never arises; the shim reaches the control plane only through `events:PutEvents` confined
to `source: millwright.step`.

## The honest residual

A job **can** emit step events claiming another job's identity **within its own run**. This is
stated rather than papered over, and it is why step rows are **display-plane, never
decision-plane** — terminal authority is
[`BatchGetBuilds`](../decisions/batchgetbuilds-authoritative.md), which no job can influence.

## Related

- [Trust model](../security/trust-model.md)
- [Job roles](../security/job-roles.md)

# Citations

[1] [Spec §7.8, §10.3](../../docs/specs/1-millwright-v1-implementable-specification.md)
