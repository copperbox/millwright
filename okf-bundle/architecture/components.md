---
type: architecture
title: Component map
tags:
  - millwright
  - architecture
  - aws
timestamp: 2026-08-12T21:22:39.114Z
---

Everything deploys from one CDK construct (`new Millwright(stack, props)`). External to AWS: one
GitHub App per deployment, one read-only deploy key per watched repo.

The spec numbers these C1–C19 and the code follows that numbering in comments, so the labels are
worth knowing.

| # | Component | Kind | Owns |
|---|---|---|---|
| C1 | Poll tick | EventBridge Scheduler, `rate(1 minute)` + jitter | Drives the poller. Cadence is the `pollCadence` prop. |
| C2 | **Poller** | Lambda, zip, **non-VPC**, reserved concurrency 1 | SSH `ls-refs` per repo, ETag'd PR polling, cron evaluation, diff, emit-then-commit. |
| C3 | Event bus | EventBridge bus | `push`/`branch`/`tag`/`pr`/`cron`/`dispatch`/`bootstrap`. Resource policy restricts `PutEvents` by principal **and `events:source`**. |
| C4 | **Launcher** | Lambda | Validate → dedupe → match → number → run record → concurrency gate → `StartExecution`. Owns rerun artifact prefix-copy. |
| C5 | Run executor | Step Functions **Standard**, deployed once (generic) | One run: synth job, control-plane model validation + registry write, then the decider loop. |
| C6 | **Decider** | Lambda wrapping a **pure library** | `decide(jobModel, states, cancelRequested) → actions`. Same library runs in the local runner. |
| C7 | Build-events handler | Lambda on the CodeBuild build-state rule | Updates job state via the `BUILD#` mapping item; sends the task token best-effort. |
| C8 | **Reporter** | Lambda on state-table Streams + 1-min sweep | Sole owner of check-run reconciliation to GitHub. |
| C9 | **State table** | DynamoDB, single-table, on-demand, TTL 90 d | The CLI's source of truth. **Never a credential store.** |
| C10 | Polling table | DynamoDB, on-demand | Ref→sha maps, PR ETags, cron bookkeeping, circuit breaker, quarantine markers. |
| C11 | CodeBuild project | One project; everything per-run via `StartBuild` overrides | Synth jobs and user jobs. ARM small default. |
| C12 | Artifact/cache bucket | S3 | Run-scoped artifacts, control-plane inputs, keyed caches. |
| C13 | Assets | S3 (CDK assets) | Static step-shim binary **and the synth tooling bundle**. |
| C14 | CMK | KMS | Encrypts every SecureString in the SSM plane. The one standing cost. |
| C15 | Config plane | SSM Parameter Store `/millwright/<name>/…` | Manifest, repo config, credentials, host-key pins, secrets. |
| C16 | Sweep | Lambda on the 1-min scheduler | Concurrency-group crash safety, stale job-role housekeeping. |
| C17 | Log groups | CloudWatch Logs | Per-build streams, 30 d default. CLI deep-links; never the UX. |
| C18 | GitHub App | External | REST-only work: check runs, PR polling, deploy-key installation. |
| C19 | Step-events writer | Lambda on a `source: millwright.step` rule | Step rows from shim events, idempotent on `(run, job, step-index)`. |

## Reading the code

Control-plane Lambda handlers live under `packages/millwright-cdk/src/runtime/<component>/`, each
split into a `handler.ts` (AWS wiring), a pure module, and a `store.ts` (DynamoDB access). The
shared contracts every component agrees on — key formats, S3 layout, SSM paths, the buildspec
renderer, the decider — live in `@copperbox/millwright-state`.

## Related

- [Writer partitioning](writer-partitioning.md) — which component may write what.
- [Control-plane and job IAM](../security/job-roles.md).

# Citations

[1] [Spec §2 — component inventory](../../docs/specs/1-millwright-v1-implementable-specification.md)
