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
- [Workflow-definition construct API](tickets/004-workflow-definition-api.md) —
  in-repo `millwright/workflows.ts`, synthesized at the triggering commit (branch-
  testable workflows) with secrets-allowlist + IAM-boundary guardrails;
  `WorkflowSet`→`Workflow`→`job`; DAG from typed artifacts; ref-pinned typed manual
  dispatch; sharing via npm, matrices via loops, `skipIf` step guards. Prototype:
  `prototypes/workflow-api/workflows.ts`. Spawned
  [Packaging and config surface](tickets/014-packaging-and-config-surface.md).
- [Artifacts and caching](tickets/009-artifacts-and-caching.md) — millwright-owned S3
  store: declared `produces`/`consumes` (synth-checked, doubles as the job DAG) with
  run-prefix IAM; GHA-style keyed dependency caches (`hashFiles` keys, restore-key
  fallback); CodeBuild native cache/artifacts unused; docker layer caching stays
  job-level in v1.
- [Secrets management and injection](tickets/008-secrets-injection.md) — SSM
  SecureString + dedicated CMK (SM ARNs as passthrough); explicit per-job secret
  declaration synthesizing least-privilege roles; CodeBuild-native env injection with
  masking; `millwright secrets set` CLI authors values.
- [Run observability DX](tickets/005-run-observability-dx.md) — CLI-first, no web UI
  in v1: `logs -f` interleaved run-level tail (polled GetLogEvents, not Live Tail) with
  wait-for-run no-arg default; `runs list/show` with 90d metadata / 30d log retention;
  workflow-scoped run numbers (`ci#142`); `logs --failed` triage and scriptable exit
  codes; `runs rerun` exists, semantics owned by orchestration.
- [Orchestration and state model](tickets/006-orchestration-state-model.md) — hybrid:
  Step Functions Standard runs a deployed-once decider loop (dispatch-on-completion,
  task-token wake on build events; decider reused by the local runner) driving one
  `StartBuild` per job; DynamoDB single-table is the CLI's source of truth (inverted
  run-number keys, 90d TTL, partitioned writers incl. in-build step shim); launcher
  Lambda dedupes + allocates run numbers; synth is the first CodeBuild job (Lambda-
  compute escape hatch); cancellation is decider input (Ctrl-C parity); rerun `--failed`
  seeds `reusedFrom` jobs via artifact prefix-copy. Spawned
  [Concurrency semantics](tickets/015-concurrency-semantics.md).
- [Local execution parity](tickets/007-local-execution-parity.md) — `millwright run`
  is always local, `dispatch` always cloud; shared pure-library decider + step shim
  behind Executor/StateSink seams (docker + local JSON vs CodeBuild + DynamoDB);
  working-tree copy default (`--clean` for commit fidelity); same images via the
  user's own docker (zero AWS calls; host-native arch); secrets from gitignored env
  file; artifacts/cache mirror S3 layout locally; `--job` reuses last local
  artifacts. Prototype: `prototypes/local-runner/SESSION.md`. Radiated
  publicly-pullable-default-images constraint to
  [Runner image model](tickets/013-runner-image-model.md).
- [Repo access auth](tickets/003-repo-access-auth.md) — hybrid: per-deployment GitHub
  App (manifest-flow setup; API work + check runs) plus per-repo read-only deploy keys,
  because App tokens die ≤1h into an API outage while SSH deploy keys keep git polling
  alive; PAT documented as small-setup fallback.
- [Polling credential during outages](tickets/011-polling-credential-during-outages.md) —
  deploy keys always for tier-1 polling (the everyday path is the outage path; App token
  retreats to REST-only work): pure-JS `ssh2` + reused `ls-refs` parser in the poller;
  `/meta`-seeded SSM host-key pins with auto-reconcile-on-mismatch; deploy keys a
  universal invariant (App-vs-PAT is REST-surface only); keys in SSM SecureString under
  the existing CMK (amends Repo access auth's Secrets Manager line), Ed25519 default.
  Spawned [SSH ls-refs spike](tickets/016-ssh-ls-refs-spike.md).
- [PR check reporting](tickets/010-pr-check-reporting.md) — per-job check runs
  (`<workflow> / <job>`; commit statuses in PAT mode, same contexts) reconciled from
  DynamoDB desired state via Streams + 1-min sweep (outage replay coalesces to
  latest-state); `millwright / synth` check bridges the pre-synth gap and surfaces
  synth failures; posted per-commit unconditionally, so reporting never depends on
  tier-2 PR polling; 7-day abandon horizon; no annotations or re-run button in v1.
- [CodeBuild provisioning-latency spike](tickets/012-codebuild-provisioning-latency-spike.md) —
  measured: PROVISIONING is 2–7 s across the whole v1 matrix (ARM small/medium ×
  standard/custom image × privileged on/off); polling detection (~30–90 s) dominates the
  push→first-log floor, validating the CodeBuild choice with no Fargate reopen; ARM
  medium on-demand confirmed; 30–40 s QUEUED bursts under concurrent starts noted as
  input to [Concurrency semantics](tickets/015-concurrency-semantics.md).

- [Packaging and config surface](tickets/014-packaging-and-config-surface.md) —
  construct library + `millwright init` thin app; three lockstep `@copperbox` packages
  (workflows / cdk / cli) with a run-model `schemaVersion` compat contract; construct
  props are infra-only (name, boundary, cadence, retention) — repos are dynamic via
  `millwright repo add` writing SSM config + generating deploy keys (security config
  operator-IAM-gated, not deploy-gated); CLI auth = plain AWS creds with SSM
  self-registration discovery; discrete guided setup (init → cdk deploy → setup →
  repo add → doctor). Spawned [Assemble the v1 spec](tickets/017-assemble-v1-spec.md)
  as the map's terminus.
- [Concurrency semantics](tickets/015-concurrency-semantics.md) — opt-in
  deployment-global concurrency groups (limit 1; keys = static strings + trigger-context
  tokens ref/workflow/repo/event, `${repo}` for repo-local); `queue` default with a
  pending-slot-of-one (newest waiting wins), `supersede` opt-in cancels in-flight via
  the existing cancellation path; dropped runs are CANCELLED `reason: superseded`;
  uniform gating for all run sources, no bypass (cancel-in-flight is break-glass);
  local runs don't enforce; CodeBuild account quota surfaced via `doctor`, not managed.
  Enforced by the launcher against a **per-ref registry written by every successful
  synth** — which also fills the previously-unrecorded pre-synth trigger-matching gap
  (amends Orchestration and Workflow-definition).
- [SSH ls-refs spike](tickets/016-ssh-ls-refs-spike.md) — proven live with pure-JS
  `ssh2` + read-only deploy key: babeld honors the `GIT_PROTOCOL=version=2` channel
  env, v2 `ls-refs` + `ref-prefix` returns 67 B vs `git/git`'s 344 KB / 5,282-ref v0
  advertisement (~5,100x); no-env fallback → v0 ad confirmed; `hostVerifier` exposes
  the raw host key for 011's SSM pinning. Exchange-sequence reference on the
  `research/ssh-ls-refs-spike` branch. Unblocks
  [Assemble the v1 spec](tickets/017-assemble-v1-spec.md).
- [Runner image model](tickets/013-runner-image-model.md) — any Linux+shell image works
  (static shim injected via S3 secondary source / local mount, never baked in); `image`
  required with job>Workflow>WorkflowSet cascade, no default; millwright publishes no
  images; image-is-the-toolchain (no setup DSL); string-typed with string-level lints
  (Docker Hub mirror warning) + auto ECR pull grants; privileged jobs must bring docker,
  prelude auto-starts dockerd when no socket is live.

## Not yet specified

- **Fail-fast** — opt-in run-level "cancel remaining jobs on first failure". Ruled out
  of v1 by [Orchestration and state model](tickets/006-orchestration-state-model.md);
  the cancellation path it would reuse now exists.
- **GHA YAML importer** — best-effort converter from `.github/workflows` to millwright
  definitions. Deferred convenience; sharpens once the native definition model exists.
- **Notifications & badges** — run-result notifications (Slack/email), status badges.
- **Run web UI** — a minimal hosted run/log viewer layered on the CLI's data. Deferred
  convenience per [Run observability DX](tickets/005-run-observability-dx.md); sharpens
  once the v1 CLI and state model exist.
- **`SecretFile` construct** — first-class file-shaped secrets (SSH keys, PEMs) instead
  of the v1 write-env-var-to-disk step. Sharpens with the definition API.
- **`DockerCache` construct** — first-class docker layer caching (buildx + ECR/S3
  backend) instead of the v1 do-it-in-your-steps approach. Sharpens with the definition
  API.
- **Webhook fast-path** — *opportunistic* webhook acceleration layered on top of polling
  (lower latency when GitHub is healthy), never a dependency. Sharpens once polling
  architecture is decided. Would also carry check-run re-run buttons (requested actions
  are webhook-only, per [PR check reporting](tickets/010-pr-check-reporting.md)).
- **Check-run annotations** — file/line annotations on job checks from structured
  test/lint output (report parsers). Ruled out of v1 by
  [PR check reporting](tickets/010-pr-check-reporting.md); sharpens if v1 grows
  built-in test-report parsing.

- **Concurrency extensions** — numeric group limits (`limit: n`), full-FIFO queues, a
  `reject` policy, and a dispatch bypass flag. Deferred by
  [Concurrency semantics](tickets/015-concurrency-semantics.md); graduate only if real
  usage demands them (the group item can carry a count without reshaping the API).

## Out of scope

- **Multi-tenancy / running millwright as a service** — different product; drags
  auth/isolation/billing into every design decision.
- **Code hosting and PR/review UX** — GitHub remains the collaboration home; millwright
  never replaces it.
- **Webhook-dependent triggering** — webhooks share fate with the outages millwright
  exists to route around. (Opportunistic acceleration stays in fog; dependency is out.)
- **Soft-fail / allow-failure jobs** — excluded from the v1 status algebra by
  [Orchestration and state model](tickets/006-orchestration-state-model.md); it
  complicates run-status derivation and PR-check semantics for a niche need.
