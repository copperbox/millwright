---
id: "004"
title: Workflow-definition construct API
type: wayfinder:prototype
status: closed
assignee: dan
blocked-by: []
---

## Question

What does the CDK-style TypeScript API for defining millwright workflows look like?
Sketch the construct model — Workflow / Job / Step (or whatever the right nouns are),
trigger bindings (push/branch/tag filters, PR events, cron, manual dispatch), job
dependencies/DAG, and what `synth` emits as the declarative job model. How does a
workflow definition coexist with the CDK infra app that deploys millwright itself
(same app? separate synth?).

Produce a rough `.ts` sketch of 2–3 realistic workflows (CI on push, deploy on tag,
PR checks) to react to live. The sketch is a discussion artifact, not a design commitment.

## Resolution

Decided live with Dan (2026-08-07) against the prototype sketch
[`prototypes/workflow-api/workflows.ts`](../../prototypes/workflow-api/workflows.ts)
(the linked asset; iterated through two rounds of reactions).

- **Definitions live in the watched repo** (`millwright/workflows.ts`); the control
  plane synthesizes **the definition at the triggering commit**, so workflow changes
  are branch/PR-testable — the core DX fix. Guardrails accepted with it: branch/PR
  runs receive **no secrets unless the ref matches a declared allowlist**, and all
  synthesized job roles sit under a **deployment-level IAM permissions boundary**.
- **Construct model**: `WorkflowSet` → `Workflow` (owns triggers) → `job(...)`.
  Steps are plain shell strings, with `Step.run(cmd, opts)` as the upgrade path.
  Not CDK/CloudFormation: `millwright synth` emits millwright's own declarative run
  model (jobs, buildspecs, trigger predicates, requested IAM); the dispatcher
  materializes bounded per-job roles and `StartBuild` calls from it. The CDK app is
  only millwright's own deployment.
- **DAG from artifacts**: `consumes: build.artifacts.dist` is the dependency edge,
  synth-checked; explicit `dependsOn` exists for artifact-less ordering. No `needs:`
  strings.
- **Triggers**: `Trigger.push/tag/pullRequest/cron/manual`. Manual dispatch always
  carries a **ref** (default: default-branch head); the definition and source are both
  pinned at that ref — `millwright dispatch release --ref v1.4.2` deploys v1.4.2 with
  v1.4.2's own workflow. Manual inputs are **typed** (choices/booleans flow into
  `steps: (inputs) => [...]`).
- **Sharing = npm packages**: platform repos export workflow functions/constructs;
  no reusable-workflow machinery. **Matrices = loops** — each job is an independent
  `StartBuild`, parallel unless an edge says otherwise; no matrix DSL.
- **Skips**: `Step.run(cmd, { skipIf: '<command>' })` — exit-0 guard compiles to
  shell that reports SKIPPED to the run view; runtime idempotency (tag-already-exists)
  stays runtime. Job-level conditions belong to
  [Orchestration and state model](006-orchestration-state-model.md).

**Constraints radiated**: dispatcher must run `npm ci` + synth at trigger time (fits as
CodeBuild phase one); secrets-allowlist + permissions-boundary enter the spec's security
model; run view needs a SKIPPED step status
([Run observability DX](005-run-observability-dx.md)).
