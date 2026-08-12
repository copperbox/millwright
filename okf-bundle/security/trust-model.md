---
type: security
title: Trust model — repo code is the adversary
tags:
  - millwright
  - security
  - iam
  - architecture
timestamp: 2026-08-12T21:24:31.462Z
---

Workflow definitions live **in the watched repo** and the control plane **executes them** (in the
[synth job](../architecture/synth-job.md)). Every security decision in millwright follows from
treating that code as attacker-influenceable.

## The named boundaries

1. **`model.json` is a named privilege boundary.** It is authored inside the synth job by repo code.
   The control plane schema-validates it and treats **every grant it requests** as
   attacker-influenceable: requested IAM is materialized only by control-plane code, capped by the
   [mandatory permissions boundary](permissions-boundary.md), with secret grants only for
   [allowlisted refs](secrets-gating.md).
2. **The `(triggers, concurrency)` map is extracted by control-plane code after validation**, never
   by the synth job — closing the [registry](../architecture/per-ref-registry.md)-overwrite vector.
3. **`PutEvents` is source-conditioned by resource policy.** Job roles may emit only
   `source: millwright.step`; a forged push needs the poller role's own credentials. See
   [Run start](../architecture/run-start.md).
4. **Job roles have no DynamoDB access and no deploy-key access** — both explicit negatives. See
   [Writer partitioning](../architecture/writer-partitioning.md).
5. **The buildspec that wraps repo steps is rendered control-plane-side**, from a shared library.
   Synth emits a step list; it never authors its own wrapper.
6. **Terminal job state comes from CodeBuild**, not from any row repo code could influence. See
   [BatchGetBuilds is authoritative](../decisions/batchgetbuilds-authoritative.md).

## Enforcement is never at synth time

Synth-time checks (including of `secretsAllowedRefs`) survive **only as fail-fast UX**. Synth runs
repo-controlled code and therefore can never be an enforcement point. If you find yourself adding a
security check to the workflows library, the real check belongs in the decider or the post-synth
step.

## Accepted, stated losses

These are known and deliberate — do not "fix" them without renegotiating the model:

- **No cross-run isolation within one workflow**: run N can read run M's artifacts. The threat model
  already executes repo code, so the isolation was never real.
- **Cache-write trust is repo-scoped.** Exact-key write scoping was illusory: any branch can compute
  the shared key legitimately.
- **A job can emit step events claiming a sibling job's identity in its own run** — which is why
  step rows are display-plane only.
- **An allowlisted ref *name* is only as strong as GitHub-side protection of that namespace.**

## Related

- [Job roles](job-roles.md) · [Secrets gating](secrets-gating.md) ·
  [GitHub auth](github-auth.md) · [Fork PR policy](fork-pr-policy.md)

# Citations

[1] [Spec §4.3, §5, §7.2, §7.8, §10, §12a](../../docs/specs/1-millwright-v1-implementable-specification.md)
