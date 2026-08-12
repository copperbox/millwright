---
type: interface
title: Workflow definition API
tags:
  - millwright
  - workflows
  - api
timestamp: 2026-08-12T21:27:30.847Z
---

Definitions live **in the watched repo** at `millwright/workflows.ts`. The control plane synthesizes
**the definition at the triggering commit**, so workflow changes are branch/PR-testable — modulo
secrets, which branch and PR runs never receive.

```ts
import { WorkflowSet, Workflow, Trigger } from '@copperbox/millwright-workflows';

const app = new WorkflowSet();
const ci = new Workflow(app, 'ci', { on: [Trigger.push({ branches: ['main'] })] });
ci.job('build', {
  image: 'public.ecr.aws/docker/library/node:22',
  steps: ['npm ci', 'npm test'],
});
export default app;
```

`WorkflowSet` → `Workflow` (owns triggers) → `job(name, props)`. **This is not CDK/CloudFormation**
— `millwright synth` emits millwright's own [run model](../schemas/run-model.md). The CDK app is
only millwright's own deployment.

## Semantics

- **The DAG comes from artifacts.** `consumes: build.artifacts.dist` *is* the dependency edge,
  synth-checked. Explicit `dependsOn` exists only for artifact-less ordering. **No `needs:` strings.**
- **Triggers**: `Trigger.push({branches})`, `Trigger.tag({pattern})`, `Trigger.pullRequest()`,
  `Trigger.cron(expr)` (UTC), `Trigger.manual({inputs})`.
- **Manual dispatch always carries a ref** (default: default-branch head); definition and source are
  both pinned at that ref. **Inputs are typed** (choices/booleans), flowing into
  `steps: (inputs) => [...]`.
- **Steps are plain shell strings**; `Step.run(cmd, opts)` is the upgrade path.
  `Step.run(cmd, { skipIf: '<command>' })` reports **SKIPPED** (`reason: skip_if`) and continues.
- **Matrices are loops** — each job is an independent `StartBuild`. **No matrix DSL.**
- **Sharing is npm packages**: platform repos export workflow functions/constructs.
- **Secrets** declared per job — see [Secrets gating](../security/secrets-gating.md).
- **Concurrency** declared per workflow — see
  [Concurrency groups](../architecture/concurrency-groups.md).
- **`image` is required** — no default; job > `Workflow` > `WorkflowSet` cascade.
- **`compute`**: `Compute.*` sizing enum, ARM small default, x86 opt-in. `timeout` per job.
- **`privileged: true`** enables docker-in-docker; the image must contain docker.
- **Reserved job name: `synth`** (it is a check context).

## Synth-time guardrails

Synth is **fail-fast UX, never enforcement** — see [Trust model](../security/trust-model.md).

**Errors**: no resolvable `image`; `consumes` without a matching `produces`; job-name collisions;
reserved name `synth`; run-model `schemaVersion` newer than the control plane's.

**Lints**: secret masking is exact-match-only (transformed values leak); implicit Docker Hub
reference (bare `node:22` — recommend the `public.ecr.aws/docker/library/...` mirror); any
`Trigger.cron` finer than the deployment's `pollCadence`.

**Synth makes no registry or network calls** — image lints are string-level only.

Code: `packages/millwright-workflows/src/`. Reference sketch: `prototypes/workflow-api/workflows.ts`.

# Citations

[1] [Spec §4](../../docs/specs/1-millwright-v1-implementable-specification.md)
[2] [Authoring workflows](../../docs/workflow-authoring.md)
