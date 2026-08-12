---
type: architecture
title: The synth job and its trust boundary
tags:
  - millwright
  - orchestration
  - security
  - codebuild
timestamp: 2026-08-12T21:23:02.359Z
---

The state machine's first step is a **synth job on CodeBuild at the triggering commit**. It executes
repo-controlled code (`npm ci` install scripts, `workflows.ts`) and is specified accordingly — it is
a named control-plane component *with* a trust boundary, not a build step.

## Specification

- **Image**: a pinned public-ECR image carrying git+node (`public.ecr.aws/docker/library/node:22`,
  full variant), pinned **by digest per control-plane release**. The synth job is explicitly exempt
  from the [image model](../interfaces/workflow-definition-api.md)'s contract, which scopes to
  *user* jobs. This is millwright pinning a public image, not publishing one.
- **Tooling**: the synth CLI/compiler arrives as a **C13 secondary source**, exactly like the shim.
  The synth tooling is always the control plane's own version and is **never resolved from the
  watched repo**. Only the repo's `millwright-workflows` library version is subject to the
  `schemaVersion` skew check.
- **Install contract**: working directory = repo root; entry point `millwright/workflows.ts`;
  package-manager discovery by lockfile (`package-lock.json` → `npm ci`; `pnpm-lock.yaml` →
  `pnpm install --frozen-lockfile`; `yarn.lock` → `yarn install --frozen-lockfile`; none →
  `npm install` + lint warning). Dependency install stays because "sharing = npm packages" is how
  workflow reuse works.
- **Clone**: via the repo's deploy key, host keys verified against the same SSM pins as the poller.
  For PR runs, one explicit extra fetch of `+refs/pull/N/head` — the PR head lives in the *base
  repo's* namespace. **No fork remote, no fork credential, ever.**
- **Role**: read on the repo's deploy-key param + host-key pins + repo config param;
  `s3:PutObject` on the run's `in/` subprefix. **No DynamoDB access at all.**
- **Outputs** land at the run's `in/` prefix: `model.json` and the packaged `source.tar.gz`.

## The boundary that matters

**The synth job cannot write the registry.** The state-machine step *after* synth is control-plane
code: it reads `model.json` from S3, schema-validates it, writes the `REG#` entry, and reconciles
job-role policies. This closes the registry-overwrite vector at the root — a hostile `workflows.ts`
cannot install triggers or concurrency config for other refs.

Everything `model.json` requests is treated as attacker-influenceable. See
[Trust model](../security/trust-model.md) and [Run model](../schemas/run-model.md).

## Bootstrap (synth-only) executions

The same state machine with a stop-after-synth flag, idempotently keyed by `(repo, ref, sha)`. Used
by [registry bootstrap](per-ref-registry.md) and `repo add` priming. They validate the model, write
the registry entry, report the `millwright / synth` check, and dispatch no jobs.

## Pre-approved escape hatch

Synth needs no docker, so it can move to CodeBuild **Lambda compute mode** if latency ever warrants.
Measured provisioning of 2–7 s means it currently doesn't.

Code: `packages/millwright-cdk/src/runtime/synth/`, `packages/millwright-cli/src/synth-job/`,
post-validation in `packages/millwright-cdk/src/runtime/post-synth/`.

# Citations

[1] [Spec §7.2](../../docs/specs/1-millwright-v1-implementable-specification.md)
