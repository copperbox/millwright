---
labels: [wayfinder:map]
---

# Millwright — wayfinder map

## Destination

An **implementable spec for millwright v1**: a single-tenant, open-sourceable CDK
application that replaces GitHub Actions *execution* with polling-driven CI/CD running in
your own AWS account. The map is done when every core architecture decision — job
compute, polling/triggering, workflow-definition model, orchestration & state, secrets,
artifacts & caching, run observability, local execution parity, repo auth, PR check
reporting — is locked and captured as a spec ready to build with no open questions.

## Notes

**Framing settled while charting** (these bound every ticket):

- Millwright is an **execution replacement only** — GitHub remains the source of truth
  for code and collaboration. No git hosting, no PR/review UX.
- **No webhook dependency.** Triggering is poll-driven, in two tiers:
  - Tier 1 (resilient core): git-protocol-observable events — push/branch/tag via
    `git ls-remote` polling — plus manual dispatch and cron. These must work whenever
    GitHub's git layer is up, even when Actions/API/webhooks are degraded.
  - Tier 2 (best-effort): PR events via GitHub API polling. Degrades when the API
    degrades; that's accepted and explicit.
- Workflows are defined **as code, CDK-style** (TypeScript constructs, synth to a
  declarative job model). No GitHub Actions YAML compatibility in v1; an importer is
  deferred (see fog). A key DX goal: run the exact workflow locally without pushing.
- **Single-tenant**: each team deploys millwright into their own AWS account. Designed
  to be open-sourced — no hardcoded account assumptions — but no multi-tenancy anywhere.
- **As serverless as possible** = minimize idle cost and ops burden; pragmatic
  exceptions allowed where serverless genuinely can't do the job.

**Working the map**: tracker conventions are in [TRACKER.md](TRACKER.md). Use the
`/grilling` skill for grilling tickets and the `/research` skill for research tickets.
Prototype tickets have no dedicated skill installed — build a rough throwaway artifact
(sketch, stub, code spike) and iterate on it live with the user.

## Decisions so far

<!-- one line per closed ticket: gist + link -->

- [Job compute runtime](tickets/001-job-compute-runtime.md) — CodeBuild on-demand EC2
  (ARM default) as the single v1 runtime: only option with zero idle cost + real
  docker-in-docker; `StartBuild` overrides, built-in queueing, S3 caching, and live
  CloudWatch streaming replace most runner plumbing; ~$51/mo at 100x5min runs/day.
  Later tiering via CodeBuild Lambda compute, not raw Lambda; no Fargate in v1. Spawned
  [CodeBuild provisioning-latency spike](tickets/012-codebuild-provisioning-latency-spike.md).
- [Polling architecture](tickets/002-polling-architecture.md) — 1-min EventBridge
  Scheduler → non-VPC Lambda doing protocol-v2 `ls-refs` (tier 1) + ETag'd PR polling
  (tier 2), diffing refs in DynamoDB, emitting events to EventBridge; ~30–90 s detection
  latency, ~$1–3/mo; quorum circuit-breaker for outages. Spawned
  [Polling credential during outages](tickets/011-polling-credential-during-outages.md).
- [Repo access auth](tickets/003-repo-access-auth.md) — hybrid: per-deployment GitHub
  App (manifest-flow setup; API work + check runs) plus per-repo read-only deploy keys,
  because App tokens die ≤1h into an API outage while SSH deploy keys keep git polling
  alive; PAT documented as small-setup fallback.

## Not yet specified

- **Concurrency semantics** — queueing, concurrency groups, cancel-superseded-runs.
  Sharpens once orchestration & state model is decided.
- **GHA YAML importer** — best-effort converter from `.github/workflows` to millwright
  definitions. Deferred convenience; sharpens once the native definition model exists.
- **Notifications & badges** — run-result notifications (Slack/email), status badges.
- **Webhook fast-path** — *opportunistic* webhook acceleration layered on top of polling
  (lower latency when GitHub is healthy), never a dependency. Sharpens once polling
  architecture is decided.
- **Packaging & config surface** — CDK app vs construct library, how a deploying team
  declares which repos/workflows to watch. Sharpens once the definition model exists.

## Out of scope

- **Multi-tenancy / running millwright as a service** — different product; drags
  auth/isolation/billing into every design decision.
- **Code hosting and PR/review UX** — GitHub remains the collaboration home; millwright
  never replaces it.
- **Webhook-dependent triggering** — webhooks share fate with the outages millwright
  exists to route around. (Opportunistic acceleration stays in fog; dependency is out.)
