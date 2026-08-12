---
type: architecture
title: Status algebra, cancellation, and rerun
tags:
  - millwright
  - orchestration
  - cli
timestamp: 2026-08-12T21:23:48.629Z
---

## States

- **Job**: PENDING → QUEUED/PROVISIONING → RUNNING → SUCCEEDED | FAILED | TIMED_OUT | CANCELLED |
  SKIPPED.
- **Run**: **PENDING and QUEUED are first-class**, then RUNNING → SUCCEEDED | FAILED | CANCELLED
  (including `reason: superseded`).

## Rules

- Transitive dependents of a failed job → **SKIPPED with `reason: upstream_failed`**, distinct from
  `reason: skip_if` (the guard path). Independent branches run to completion.
- Run is FAILED if any job FAILED or TIMED_OUT (including the run-deadline path); CANCELLED if
  cancelled; SUCCEEDED **iff** every job SUCCEEDED or was SKIPPED via guard.
- **No fail-fast in v1** (deferred). **No soft-fail / allow-failure** (out of scope).

## Cancellation

**Cancellation is decider input, not an outside kill.** The CLI writes `cancelRequested` on the run
record and sends the task token (read from the Run item, stale-safe); the decider `StopBuild`s
in-flight builds, marks non-terminal jobs CANCELLED, marks the run CANCELLED, and exits cleanly.

`StopExecution` is **documented break-glass only** — it leaves jobs non-terminal and checks
unreported. Local Ctrl-C sets the same flag through the same path.

```sh
millwright runs cancel <run>   # every job lands terminal
```

## Rerun

`millwright runs rerun <run>` creates a **new run** (fresh number, `rerunOf`) from the **stored job
model — no re-synth**. That is deliberate: a rerun reproduces the run you had, not the run the repo
would produce now.

`--failed` reruns FAILED/TIMED_OUT/CANCELLED jobs plus their SKIPPED dependents:

- The **launcher** prefix-copies succeeded jobs' `out/<job>/` subtrees into the new run's prefix
  (which is why the launcher role, not the decider, carries the S3 copy grants).
- The decider seeds those jobs terminal SUCCEEDED with `reusedFrom`.
- Nothing failed → `--failed` is rejected.

Reruns gate through [concurrency groups](concurrency-groups.md) like any other run — there is no
bypass flag anywhere in v1.

## Step-level status

The shim **does not write the table**. It emits step events via `events:PutEvents`, confined by the
job role's grant to `source: millwright.step`; the step-events writer (C19) writes step rows,
idempotent on `(run, job, step-index)`. Step rows are **display-plane, never decision-plane** — see
[Writer partitioning](writer-partitioning.md).

# Citations

[1] [Spec §7.5–§7.8](../../docs/specs/1-millwright-v1-implementable-specification.md)
