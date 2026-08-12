---
type: security
title: Job roles — stable, two-variant
tags:
  - millwright
  - security
  - iam
  - codebuild
timestamp: 2026-08-12T21:24:51.320Z
---

Job roles are **stable per `(repo, workflow, job)`**, in **two variants**: *full-grants* and
*no-secret-grants*. Per-run role creation was considered and
[dropped](../decisions/stable-job-roles.md).

- Deterministic names under the **`mw-*`** namespace, truncated/hashed to IAM's 64-char limit,
  boundary-attached, tagged.
- **The decider selects the variant at dispatch** by matching the run's ref against
  [`secretsAllowedRefs`](secrets-gating.md). PR refs (`refs/pull/N`) are structurally unmatchable →
  always no-secret. Unset allowlist → **no ref receives secrets** (fail-closed).

## The no-secret variant contains nothing model-derived

That property is what makes it safe for untrusted refs — an untrusted-ref synth **never mutates any
role**. Its grants:

- S3 read on `runs/<repo>/<wf>/*/in/*` and run-wide artifact read.
- S3 write on `runs/<repo>/<wf>/*/out/<job>/*` — its own subtree only.
- Cache get/put on `cache/<repo>/*`, with prefix-conditioned `s3:ListBucket`.
- `events:PutEvents` conditioned to `source: millwright.step`.
- Private-ECR pull on the repos in repo config's **`ecrPullRepos`** allowlist.
- **No DynamoDB access. No deploy-key access** — explicit negatives.

## The full variant adds

- `ssm:GetParameters` (**plural** — required by CodeBuild's `env.parameter-store` resolution) on
  exactly the declared secret params, plus `kms:Decrypt` on the CMK.
- `secretsmanager:GetSecretValue` on declared passthrough ARNs.

It is **created/updated only from validated models of allowlisted refs**, by the control-plane
post-synth step. The decider verifies a stored **policy hash** against the run's model at dispatch
and idempotently updates on mismatch, retrying `StartBuild` through propagation (bounded, ~60 s).
That wait therefore lands only on grant-changing runs of trusted refs.

## Escalation guards on the minting path

The decider's IAM grants carry conditions, so a decider driven by a hostile `model.json` cannot mint
or pass an unbounded role:

- `iam:CreateRole` / `iam:PutRolePolicy` carry an `iam:PermissionsBoundary` condition pinned to the
  [boundary ARN](permissions-boundary.md).
- `iam:PassRole` is scoped to the `mw-*` namespace with
  `iam:PassedToService: codebuild.amazonaws.com`.

## Housekeeping

The sweep deletes role pairs whose `(workflow, job)` no longer appears in any registry entry after
**30 days**. Quota pressure is structurally gone; `doctor` still reports role count.

Code: `packages/millwright-state/src/job-roles.ts`, `job-role-policies.ts`;
`packages/millwright-cdk/src/runtime/job-roles/`, `packages/millwright-cdk/src/job-role-guards.ts`.

## Related

- [Control-plane role inventory](control-plane-roles.md)

# Citations

[1] [Spec §10.2, §10.3](../../docs/specs/1-millwright-v1-implementable-specification.md)
