---
type: schema
title: SSM config plane
tags:
  - millwright
  - ssm
  - schema
  - secrets
  - security
timestamp: 2026-08-12T21:26:35.120Z
---

Everything configurable and every credential lives under `/millwright/<name>/…` in SSM Parameter
Store. All SecureStrings sit under the deployment's dedicated CMK, giving a **two-gate posture**:
`ssm:GetParameter`/`GetParameters` **and** `kms:Decrypt`.

| Path | Type | Contents |
|---|---|---|
| `/millwright/<name>/manifest` | String | Deployment manifest; the CLI's discovery root. |
| `/millwright/<name>/repos/<repo>/config` | String (JSON) | `secretsAllowedRefs`, `prPolling`, `forkPrPolicy` (default off), `ecrPullRepos` (private-ECR pull allowlist). Written by `repo add/update` under operator IAM. |
| `/millwright/<name>/repos/<repo>/deploy-key` | SecureString | Ed25519 private key (~400 B). |
| `/millwright/<name>/github/app` | SecureString | App id + private-key PEM from the manifest exchange. |
| `/millwright/<name>/github/host-keys` | String | Pinned SSH host keys, seeded from GitHub's `/meta`. |
| `/millwright/<name>/secrets/<scope>/<NAME>` | SecureString | Workflow secrets; `<scope>` defaults to the repo. |

Existing **Secrets Manager ARNs are accepted as passthrough references**; millwright itself stores
nothing in Secrets Manager. Why: an Ed25519 key is ~400 B and SSM standard tier is free — Secrets
Manager would ~10× the polling stack's cost at 50 repos.

## Config is operator-IAM-gated, not deploy-gated

**Repos are dynamic, not construct props.** `millwright repo add` writes the repo's config param and
generates its deploy key — **no `cdk deploy` to add a repo**. The poller reads repo config from SSM
by path prefix; DynamoDB stays purely run state.

This is the intended split: security and cost knobs are guarded by *operator IAM on SSM paths*,
which is a finer and more auditable gate than "who can run `cdk deploy`".

Code: `packages/millwright-state/src/ssm-paths.ts`, `repo-config.ts`;
`packages/millwright-cli/src/config-plane.ts`.

## Related

- [GitHub auth](../security/github-auth.md) · [Secrets gating](../security/secrets-gating.md)

# Citations

[1] [Spec §9.2, §3.3](../../docs/specs/1-millwright-v1-implementable-specification.md)
