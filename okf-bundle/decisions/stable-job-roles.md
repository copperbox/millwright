---
type: decision
title: Per-run job roles were dropped
tags:
  - millwright
  - security
  - iam
  - codebuild
timestamp: 2026-08-12T21:25:00.786Z
---

Earlier designs minted a **fresh IAM role per run**, for cross-run isolation. That was dropped in
favour of [stable two-variant roles](../security/job-roles.md). The arguments are recorded so they
are not re-derived.

## Why per-run roles fail

1. **IAM eventual consistency.** The repo's own provisioning spike
   (`prototypes/codebuild-provisioning-spike/measure.sh`) contains a 12×5 s retry loop "while the
   fresh role propagates". Role creation is not usable on a hot path.
2. **Quota arithmetic.** The spec's own capacity example implies ~500 standing roles against IAM's
   1,000-role default limit — with no headroom and no cleanup story that keeps up.
3. **CreateRole throttling** on the dispatch path, unrebutted.

## Why the obvious alternative is also ruled out

Scoping a stable role down per-run via an **STS session policy** does not work: `StartBuild` has
**no session-policy channel** — `serviceRoleOverride` takes a bare role ARN. There is no place to
attach one.

**Do not re-derive this.** If cross-run isolation is genuinely needed for a specific job, the
deferred path is *per-run role layering for that job*, not a return to per-run roles everywhere.

## What was given up

Cross-run isolation within one workflow: run N can read run M's artifacts. Accepted because the
threat model already executes repo code in the same workflow — see
[Trust model](../security/trust-model.md).

## History

Tickets 004 ("dispatcher materializes roles") and 008 ("synth generates the role") contradicted each
other. Resolved for **control-plane code**; 008's reading is explicitly ruled out, because synth
runs repo code.

# Citations

[1] [Spec §10.2, §10.4, §17 amendment 8, §18](../../docs/specs/1-millwright-v1-implementable-specification.md)
