---
type: architecture
title: Check reporting to GitHub
tags:
  - millwright
  - github
  - orchestration
  - reporter
timestamp: 2026-08-12T21:25:53.995Z
---

The **reporter (C8) is the sole owner** of check-run reconciliation. Nothing else calls the checks
API.

## Granularity and contexts

- One check per job, named **`<workflow> / <job>`** (synth-validated names ⇒ stable contexts).
- Plus one **workflow-scoped synth check `<workflow> / synth`** per run, created `in_progress` at
  run start (the run's workflow is known *pre*-synth), then completed on synth success — at which
  point per-job checks batch-create as `queued` — or **failed with the error in its summary**. A
  broken `workflows.ts` is therefore always visible rather than silent.
- Bootstrap-only executions report the repo-level **`millwright / synth`** context (single
  idempotent writer per sha).
- `synth` is a **reserved job name**; synth errors on collision.

**Branch protection**: require the gating workflows' `<workflow> / synth` contexts (and whichever
job contexts should gate) — **not** `millwright / synth`, which only bootstrap-only executions
report. PAT mode reports commit statuses under identical names, so the same required contexts work.

## Ownership under concurrency

The check item carries **`ownerRun`**, and the rule is **the newest run owns the context**.

- The decider's desired-state upsert is conditional on its run number ≥ the stored owner's.
- A lower-numbered run's write is **silently dropped** (its jobs still render fully in `runs show`).
- Same-or-newer writes carry `check_run_id` forward, so the reporter updates one check run rather
  than minting duplicates.

Contexts embed the workflow name and synth checks are workflow-scoped, so owner comparison is always
within **one workflow's** number sequence — total wherever it is used.

## Architecture

Desired-state reconciliation via **DynamoDB Streams** (happy path) with the **1-min sweep** for
unconverged items — both owned by the reporter. The reporter posts the *latest* desired state, so an
outage replay coalesces to one call per check.

## Degradation

Per-item exponential backoff (1 m → 15 m cap) honoring `Retry-After`. Unconverged after **7 days** →
**abandoned** (visible in `runs show`); the 90-day TTL clears it. Duplicate creates from crash
windows are benign. **A late flush is still true for its sha and can never bless a newer commit** —
that property is what makes best-effort reporting safe.

## Scope and content

Every cloud run reports to its commit sha. Because checks attach to **shas**, PR reporting never
depends on tier-2 polling. **Local runs never report.** Budget ≈ 1,500 calls/day against 5,000/hr.

Job-check markdown carries run number, per-step conclusions and durations, the failed step with last
log lines, and a triage command; the details URL deep-links to CloudWatch. PAT mode gets a ~140-char
description plus URL.

**V1 omissions**: no file/line annotations; no check-run re-run button (requested actions are
webhook-delivered — rerun stays in the CLI).

Code: `packages/millwright-cdk/src/runtime/reporter/`, `packages/millwright-state/src/checks.ts`.

# Citations

[1] [Spec §13.2](../../docs/specs/1-millwright-v1-implementable-specification.md)
