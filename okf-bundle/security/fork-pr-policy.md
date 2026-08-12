---
type: security
title: Fork PRs and PR shas
tags:
  - millwright
  - security
  - github
  - polling
timestamp: 2026-08-12T21:25:40.927Z
---

## PR runs build the head sha, never the merge sha

The merge ref exists **only via the REST API**. Using it would couple tier 1's resilience to tier 2,
which is exactly what the two-tier split exists to avoid.

Fetch mechanism: `+refs/pull/N/head` **from the base repo's namespace**, via the repo's deploy key.
No fork remote, no fork credential, ever.

Runs key off the **PR ref and head sha**, never the fork's branch name — which dissolves cross-fork
branch-name collisions.

## PR runs receive no secrets, structurally

`refs/pull/N` has no short name, so it can never match a
[`secretsAllowedRefs`](secrets-gating.md) pattern. This is a rule, not an emergent property.

## Fork PRs are off by default

A repo-config toggle (`forkPrPolicy`, default **off**): no runs for fork-authored PRs until the
operator opts in via `millwright repo update --fork-prs on`.

**Rationale**: even with no secrets, fork code executes in the
[synth job](../architecture/synth-job.md), which holds the repo's **deploy key**. Exfiltration there
is persistent private-code access — a materially worse outcome than leaking one build's secrets.

Same-repo PRs run by default, because the pusher already had write access.

# Citations

[1] [Spec §13.1a, §12a](../../docs/specs/1-millwright-v1-implementable-specification.md)
