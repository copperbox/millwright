---
id: "007"
title: Local execution parity
type: wayfinder:prototype
status: closed
assignee: dan
blocked-by: ["004"]
---

## Question

How does the exact workflow definition that runs in AWS also run locally with fast
feedback — the core DX promise? What is the contract between synth output and a local
runner; what fidelity is promised (e.g. same container image locally via docker, but
not the same compute service); how are secrets/artifacts faked or bridged locally?
Blocked on [Workflow-definition construct API](004-workflow-definition-api.md) — the
local runner consumes whatever synth emits.

## Resolution

Decided live with Dan (2026-08-07) against the prototype
[`prototypes/local-runner/SESSION.md`](../../prototypes/local-runner/SESSION.md)
(annotated CLI session; mechanics seam in
[`runner-sketch.ts`](../../prototypes/local-runner/runner-sketch.ts) — both linked
assets, updated with the decisions below).

- **CLI shape: verb split, no flag.** `millwright run <wf>` is *always local*;
  `millwright dispatch <wf>` is always cloud. Impossible to run in the wrong place.
- **Architecture: shared core, two thin hosts.** The decider from
  [Orchestration and state model](006-orchestration-state-model.md) is a pure library
  (`decide(jobModel, states, cancelRequested) → actions`); cloud and local implement
  the same two seams — `Executor` (StartBuild ↔ `docker run`) and `StateSink`
  (DynamoDB ↔ `.millwright/runs/local-N.json`). Same DAG logic, same step shim, same
  SKIPPED semantics, same terminal states. Ctrl-C sets the same `cancelRequested`
  flag through the same decider path.
- **Synth is in-process** (bundle `millwright/workflows.ts` directly) — sub-second
  feedback; the cloud's npm-ci-in-CodeBuild synth fidelity gap is accepted.
- **Source: working-tree copy by default** — git-aware copy per job (no bind-mount:
  clean per-job copies, no host node_modules leakage); `--clean` runs `git archive
  HEAD` for bit-for-bit cloud fidelity.
- **Images: same image, user's docker.** Jobs run in their declared image via local
  docker; pull auth/discovery delegate entirely to the user's local docker config —
  millwright does no registry auth and makes **zero AWS calls locally**. Multi-arch
  resolves host-native by default; `--platform` opts into exact cloud arch.
  Constraint radiated to [Runner image model](013-runner-image-model.md): default
  images should be publicly pullable so zero-setup local runs work.
- **Secrets**: gitignored `.millwright/secrets.env` (or `--secrets-file`) satisfies
  the same env-var contract; missing declared secrets fail before any job starts,
  naming what's needed. No SSM/SM reads, per [Secrets](008-secrets-injection.md).
- **Artifacts & cache**: artifacts mirror the S3 layout under
  `.millwright/runs/<id>/…`; dependency cache is a local dir using the same keys,
  per [Artifacts and caching](009-artifacts-and-caching.md).
- **Inner loop**: `--job X` runs one job, satisfying `consumes` from the most recent
  local run's artifacts (reuse printed with age; error names the producing job if
  absent); `--with-deps` runs the ancestor subgraph instead.
- **Context**: trigger predicates are never evaluated locally; `MILLWRIGHT_*` env
  vars are synthesized from the checkout (dirty tree → `-dirty` sha), with overrides
  like `--as-tag` for faking tag context. Typed manual inputs prompt interactively
  or come from `--input k=v`.
- **Privileged jobs** mount the host docker socket with a one-line fidelity warning;
  no dind sidecar in v1.
- **Identity**: local runs are `local-N` per clone under gitignored `.millwright/`,
  a separate namespace from cloud run numbers — never in `runs list`.
- **Advisory locally**: `Compute.*` sizing ignored (noted); `timeout` enforced.

The parity contract table in the SESSION.md prototype is the spec-ready summary of
what's identical (model, decider, shim, images, layouts, contracts) vs deliberately
different (compute service, IAM absent, source mode, run identity).
