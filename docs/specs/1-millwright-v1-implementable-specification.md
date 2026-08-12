# Millwright v1 — Implementable Specification

**Provenance**

- Discussion: https://github.com/copperbox/millwright/discussions/1
- Roster: gpt, opus5, naysmith, security, advocate, kimi (quorum 5 of 6)
- Date: 2026-08-12
- Escalated questions: none

---

# cto - claude-fable-5

# Millwright v1 — Implementable Specification (final, council-revised)

**Status**: v1 spec, final. Assembled 2026-08-09 from the resolutions of wayfinder tickets 001–016, revised by full council review: fifteen concerns (c1–c15) debated and resolved, followed by a red-team pass whose objections are ruled in §B below. This document is self-contained and supersedes the convene-time draft in the discussion body.
**Provenance**: every decision traces to a closed ticket on the wayfinder map or to a council ruling recorded here; §17 logs where later decisions amended earlier ones (now including four council-discovered amendments), §18 records the spec-filled gaps and their council dispositions, §20 summarizes each concern's resolution.

---

## Escalated questions

**None.** All fifteen council concerns closed as resolved; none required escalation to the repository owner. The red-team pass produced three blocking objections and two advisories, all ruled non-blocking with their repairs folded into the sections below.

---

## B. Red-team objections — rulings

### B1 — c5's emit-then-commit vs c7's provenance check (non-blocking; repair adopted)

Correct as analyzed: validating poller-shaped events against C10's last-seen ref map cannot work under emit-then-commit ordering — at event time the map still holds the old sha, so acceptance becomes a race against a DynamoDB write, and in the crash window a rejected event's dedupe item suppresses the retry, silently dropping a push. Rather than reorder (commit-then-emit stays ruled out — it drops pushes), the repair removes the flawed check and replaces it with a stronger, static one:

- **Provenance is enforced by the bus resource policy, conditioned on `events:source`** (a documented EventBridge condition key): the poller's role may `PutEvents` only with `source: millwright.poller`; operator CLI principals only with `source: millwright.cli`; job roles only with `source: millwright.step` (the shim path from c3). The launcher requires `source: millwright.poller` for `push`/`branch`/`tag` events and `millwright.cli` for `dispatch`/`bootstrap` events. A forged push now requires the poller role's own credentials — strictly stronger than the ref-map cross-check, with no dependency on C10 state or write ordering. The launcher's cross-check against C10's last-seen map is **deleted**.
- **Launcher ordering is pinned**: source/shape validation (static, no I/O) → content-keyed dedupe put → registry match → counter → run record → gate → `StartExecution`. Since validation precedes the dedupe write, a rejected event can never poison the dedupe item. Additionally, the dedupe item is a **processing record, not a tombstone**: once the run is created its id is written onto the item, so a launcher crash-and-redeliver resumes idempotently from the record instead of dropping the event.
- **The `repo add` prime event is pinned** (the objection's second instance): the CLI emits it with `source: millwright.cli`, kind `bootstrap`, carrying the repo and its default-branch head sha (resolved via `ls-refs` with the freshly minted deploy key — which doubles as an install-time key check). The launcher routes `bootstrap` events to the synth-only execution path from c1. No poller-shaped event is ever CLI-emitted.

### B2 — c11's ownership rule doesn't cover `millwright / synth` (non-blocking; repair adopted)

Correct: run numbers are per-workflow, one push can trigger N workflows, and a shared synth context would compare run numbers across independent sequences — c11's totality claim was false for exactly the check §13.2 recommended requiring. Repair:

- **Synth checks are workflow-scoped: `<workflow> / synth`.** Every run belongs to exactly one workflow, known at run creation, so the context is determined pre-synth. c11's owner rule (`ownerRun` conditional on run number ≥ stored owner) is now total for every per-run context, synth included. `synth` becomes a **reserved job name** (synth-time error on collision).
- **Bootstrap-only executions** (c1) report the repo-level **`millwright / synth`** context. Bootstraps are idempotently keyed by `(repo, ref, sha)`, so that context has a single writer per sha and needs no ordering rule.
- Branch-protection docs change accordingly: require the synth contexts of the workflows that gate merges (e.g. `ci / synth`), not `millwright / synth`.

### B3 — c4's stable roles have no ref dimension (non-blocking; horn picked, and a third path adopted)

Correct that the disposition was silent and that both stated horns cost something already ruled on. The adopted design removes the fork:

- **The no-secret-grants variant contains nothing model-derived.** Its grants are structural — S3 read on `runs/<repo>/<wf>/*/in/*` and run-wide artifact read, write on `runs/<repo>/<wf>/*/out/<job>/*`, cache get/put under `cache/<repo>/*` with prefix-conditioned `s3:ListBucket` — plus **private-ECR pull grants sourced from operator repo config, not from the model** (`repo add/update --ecr-repos`, operator-IAM-gated per §3.3). This is no new burden: private-ECR pull already requires the operator to edit the ECR repository's resource policy (§11.2), so the operator was always in the loop; the config entry replaces a model-derived grant with a declared one. Consequence: **untrusted-ref synths never mutate any role.** A feature branch cannot alter the execution identity of anything.
- **The full-grants variant is updated only from synths of refs matching `secretsAllowedRefs`.** Trusted refs editing the roles their own runs use is the intended behavior. Where trusted refs' models differ (main vs release/*), the decider verifies a stored policy hash against the run's model at dispatch and idempotently updates on mismatch, retrying `StartBuild` through IAM propagation (bounded, ~60 s) — the propagation wait lands only on grant-changing runs of trusted refs, which is the workflow-edit path where a retry already exists.
- **The branch-testability guarantee survives in the only form it ever had.** What a branch cannot test is exactly the set of secret-bearing grants — which branch runs were already forbidden to exercise by ticket 004's own guardrail and c10/c12's rulings. "Branch/PR-testable" was always modulo secrets; the spec now says so explicitly.
- One consequential simplification is folded in: cache-write scope is `cache/<repo>/*` rather than the job's exact key. Exact-key write scoping was already illusory (any branch computes the same `hashFiles` key from the same lockfile and writes the shared entry legitimately), and key-hash grants would have re-imported per-run role mutation through the back door. Cache trust is repo-scoped and stated as such.

### Advisories (both adopted, one sentence each)

- **c14 × carry-over**: the run-level wall-clock deadline is anchored to the **original run start** and carries across carry-over executions; a fresh execution never resets the clock (§7.3).
- **c9 × c5**: the installation token is minted and cached **per consumer Lambda** (reporter, tier-2 poll path), warm-container-amortized — the spec does not claim a single global mint (§13.1).

### What held

The red team confirmed c2/c3, c13, and c7's PutEvents boundary as sound; those rulings stand as issued, with B1's repair strengthening the last.

---

## 1. What millwright is

Millwright is a **single-tenant, open-sourceable CDK application that replaces GitHub Actions *execution*** with polling-driven CI/CD running in your own AWS account. GitHub remains the source of truth for code and collaboration — millwright does no git hosting and no PR/review UX.

**Framing invariants** (bound every section below):

- **No webhook dependency.** Triggering is poll-driven, in two tiers: **Tier 1 (resilient core)** — git-protocol-observable events (push / branch / tag) via SSH `ls-refs` polling, plus manual dispatch and cron; works whenever GitHub's git layer is up, even when the REST API, Actions, and webhooks are down. **Tier 2 (best-effort)** — PR events via GitHub REST polling; degrades when the API degrades; accepted and explicit.
- **Workflows are code, CDK-style**: TypeScript constructs in the watched repo, synthesized to a declarative run model at the triggering commit. No GitHub Actions YAML compatibility in v1.
- **The exact workflow runs locally without pushing** (`millwright run`), sharing the cloud's decider and step shim.
- **Single-tenant**: each team deploys millwright into their own AWS account. No multi-tenancy anywhere; no hardcoded account assumptions.
- **As serverless as possible**: the design's only standing costs are a KMS CMK (~$1/mo) and the polling Lambda (~$1–3/mo).

---

## 2. Component inventory

Everything deploys from one CDK construct (`new Millwright(stack, props)`, §3). External to AWS: one GitHub App per deployment, one read-only deploy key per watched repo.

| # | Component | Kind | Role |
|---|---|---|---|
| C1 | Poll tick | EventBridge Scheduler, `rate(1 minute)` + jitter window | Drives C2. Cadence is the `pollCadence` construct prop. |
| C2 | **Poller** | Lambda, zip-packaged, **non-VPC**, reserved concurrency 1, timeout ≥ 2× `pollCadence` | Per tick: SSH `ls-refs` every repo at bounded fan-out (§6.1), ETag'd PR polling, cron evaluation (§6.4), diff against C10, emit-then-commit to C3 (§6.1). Non-VPC is load-bearing: NAT (~$32/mo) would dominate the stack's cost. |
| C3 | Event bus | EventBridge bus | Carries `push` / `branch` / `tag` / `pr` / `cron` / `dispatch` / `bootstrap` events. Resource policy restricts `PutEvents` by principal **and `events:source`** (§7.1). |
| C4 | **Launcher** | Lambda | Consumes C3 events: validates source/shape, dedupes on a content-derived key, matches events → workflows via the per-ref registry (§8.3) with bootstrap-on-miss, gates concurrency groups (§8.4), allocates run numbers, writes run records, calls `StartExecution` on C5. Owns rerun artifact prefix-copy (§7.7). |
| C5 | Run executor | Step Functions **Standard** state machine, deployed once (generic) | Executes one run: synth job, control-plane model validation + registry write, then the decider loop (C6) with a caught-timeout token wait (§7.3). Supports synth-only (bootstrap) executions and carry-over re-execution. Never on the per-poll path. |
| C6 | **Decider** | Lambda wrapping a **pure library** | `decide(jobModel, states, cancelRequested) → actions`. Reads `model.json` from S3 (cached) + job states, treats `BatchGetBuilds` as **authoritative** for terminal states, fires `StartBuild` per ready job, handles bounded retries/timeouts/cancellation/SKIPPED, reconciles job-role policy at dispatch (§10.2). Same library runs in the local runner. |
| C7 | Build-events handler | Lambda on the EventBridge CodeBuild build-state rule | Updates job state in C9 (via the `BUILD#` mapping item), reads the task token from the Run item and sends it best-effort so C5 wakes instantly on any completion. |
| C8 | **Reporter** | Lambda on C9 DynamoDB Streams + the 1-min sweep | Sole owner of check-run reconciliation to GitHub (§13.2): stream path is the happy path; unconverged items fall to the sweep. |
| C9 | **State table** | DynamoDB, single-table, on-demand, TTL 90 d (registry items exempt) | The CLI's source of truth: runs, jobs, steps, counters, event dedupe/processing records, concurrency groups, check desired-state, per-ref registry, build-id mapping. Schema in §9.1. **Never a credential store.** |
| C10 | Polling table | DynamoDB, on-demand | Per-repo ref state (last-seen ref→sha map, compressed — required, §6.1), PR ETags, cron `last-fired-minute` bookkeeping, quorum circuit-breaker item, per-repo quarantine markers. |
| C11 | CodeBuild project | One project; everything per-run via `StartBuild` overrides | Runs synth jobs and user jobs. environmentType `ARM_CONTAINER`, computeType `BUILD_GENERAL1_SMALL` default; x86 opt-in via `environmentTypeOverride`. Lambda compute mode is the synth escape hatch. Built-in `QUEUED` phase is the only queue. 36 h max duration. |
| C12 | Artifact/cache bucket | S3 | Run-scoped artifacts and control-plane inputs under a split run prefix (§9.3), keyed dependency caches. Lifecycle rules per `retention` prop. |
| C13 | Assets | S3 (CDK assets) | The static step-shim binary **and the synth tooling bundle** (§7.2), injected into builds as secondary sources. |
| C14 | CMK | KMS customer-managed key | Encrypts every SecureString in the SSM plane: workflow secrets, deploy keys, App PEM. The design's one standing cost. |
| C15 | Config plane | SSM Parameter Store under `/millwright/<name>/…` | Deployment manifest, per-repo config, credentials, host-key pins, workflow secrets. Paths in §9.2. |
| C16 | Sweep | Lambda on the 1-min scheduler | Reconciliation: concurrency-group crash safety (§8.4), stale job-role housekeeping (§10.2). (Check reconciliation belongs to C8 alone.) |
| C17 | Log groups | CloudWatch Logs | Per-build streams; retention 30 d default (`retention` prop). CLI deep-links; never the UX. |
| C18 | GitHub App | External, per deployment | REST-only work: check runs, tier-2 PR polling, deploy-key installation. Created via the manifest flow by `millwright setup`. Permissions: Contents: read, Checks: write, Commit statuses: write, **Pull requests: read**, Administration: write (deploy-key install). |
| C19 | Step-events writer | Lambda on a C3 rule (`source: millwright.step`) | Writes step rows from shim-emitted events, idempotent on `(run, job, step-index)` (§7.8). |

---

## 3. Packaging, versioning, configuration

### 3.1 Packages

Three npm packages under the existing **`@copperbox`** scope, released in lockstep with one version:

| Package | Contents | Installed where |
|---|---|---|
| `@copperbox/millwright-workflows` | Tiny definition library (`WorkflowSet`, `Workflow`, `Trigger`, `Secret`, `Artifact`, `Cache`, `Compute`, `Step`, `hashFiles`). **No `aws-cdk-lib` dependency.** | The only install in watched repos. |
| `@copperbox/millwright-cdk` | The `Millwright` construct + bundled control-plane assets (Lambda code, shim binary, synth tooling bundle, state machine). | The operator's CDK app. |
| `@copperbox/millwright-cli` | `bin: millwright`; npx-able. | Operator + developer machines. |

**Compatibility contract**: the run model carries a `schemaVersion`. The control plane accepts schema **≤ its own**; synth fails loud otherwise. This governs skew between a repo's workflows lib and the deployed control plane. The synth *tooling* is always the control plane's own (delivered per §7.2), so only the definition library's schema output is subject to skew.

### 3.2 Deployment shape

**Construct library + thin generated app.** `millwright init` scaffolds a minimal two-file CDK app instantiating `new Millwright(stack, {...})`; CDK-native teams compose the construct into their own app. Upgrades are npm version bumps + `cdk deploy` — never a git merge of a cloned template.

```ts
new Millwright(stack, 'Millwright', {
  deploymentName: 'millwright',      // default; namespaces SSM + resources
  permissionsBoundary: boundaryArn,  // REQUIRED — see below
  pollCadence: Duration.minutes(1),  // default 1 min
  retention: { logs: Duration.days(30), metadata: Duration.days(90) },
});
```

**`permissionsBoundary` is required.** The construct **throws at construct time** when it is absent, so the failure surfaces as a `cdk synth` error on the operator's machine — never as a deployment that quietly mints unbounded job roles. The only opt-out is the explicit sentinel `permissionsBoundary: Boundary.NONE`, which emits a synth-time warning: the risk is visible in the file the operator wrote, which a missing prop never is. This prop is unlike every other knob because it is the only cap on what repo-editable definitions can request (§10.1); that asymmetry is why it alone is required. (Restores ticket 004's accepted guardrail; §17 amendment 9.)

Notification targets are deliberately absent (notifications are deferred).

### 3.3 Config split

**Security/cost config is operator-IAM-gated, not deploy-gated.** Repos are dynamic, not construct props: `millwright repo add` (§15) writes the repo's config param and generates its deploy key — no `cdk deploy` to add a repo. Repo config carries `secretsAllowedRefs`, `prPolling`, the fork-PR policy (§13.1a), and the private-ECR pull allowlist (§10.2). The poller reads repo config from the SSM plane by path prefix; DynamoDB stays purely run state.

### 3.4 CLI discovery and auth

**AWS credentials are the CLI's only auth** (profile / SSO / env — no millwright tokens). The construct self-registers a manifest param at `/millwright/<name>/manifest`. The CLI lists `/millwright/*` and auto-picks when the account+region has exactly one deployment; otherwise requires `MILLWRIGHT_DEPLOYMENT` / `--deployment`. No committed pointer file in watched repos.

---

## 4. Workflow definition API

Definitions live **in the watched repo** at `millwright/workflows.ts`. The control plane synthesizes **the definition at the triggering commit**, so workflow changes are branch/PR-testable — modulo secrets, which branch and PR runs never receive (§4.3); that qualification has always been the guardrail's meaning and is now stated. Reference sketch: `prototypes/workflow-api/workflows.ts`.

### 4.1 Construct model

`WorkflowSet` → `Workflow` (owns triggers) → `job(name, props)`; `consumes: build.artifacts.dist` is the DAG edge (full example: `prototypes/workflow-api/workflows.ts`). This is **not** CDK/CloudFormation: `millwright synth` emits millwright's own declarative run model (§5). The CDK app is only millwright's own deployment.

### 4.2 Semantics

- **DAG from artifacts**: `consumes: build.artifacts.dist` is the dependency edge, synth-checked. Explicit `dependsOn` for artifact-less ordering. No `needs:` strings.
- **Triggers**: `Trigger.push({branches})`, `Trigger.tag({pattern})`, `Trigger.pullRequest()`, `Trigger.cron(expr)` (UTC, §6.4), `Trigger.manual({inputs})`.
- **Manual dispatch always carries a ref** (default: default-branch head); definition and source are both pinned at that ref. Manual **inputs are typed** (choices/booleans), flowing into `steps: (inputs) => [...]`.
- **Steps** are plain shell strings; `Step.run(cmd, opts)` is the upgrade path. `Step.run(cmd, { skipIf: '<command>' })` reports **SKIPPED** (`reason: skip_if`) and continues the job.
- **Matrices = loops** — each job is an independent `StartBuild`. No matrix DSL.
- **Sharing = npm packages**: platform repos export workflow functions/constructs.
- **Secrets** declared per job (§11.2 injection, §10 IAM): `secrets: { NPM_TOKEN: Secret.named('npm-token'), X: Secret.fromSecretsManager(arn) }`. `Secret.named('x')` resolves to `/millwright/<name>/secrets/<repo>/x` — scope defaults to the repo; an explicit `scope:` option addresses shared secrets. No cross-repo ambient sharing.
- **Concurrency** declared per workflow (§8.4): `concurrency: { group: 'deploy-${repo}', policy: 'queue' | 'supersede' }`.
- **`image` is required** — no default; job > `Workflow` > `WorkflowSet` cascade; synth fails clearly when a job resolves to nothing (§11.1).
- **`compute`**: `Compute.*` sizing enum, ARM small default, x86 opt-in. `timeout` per job; per-job attempt cap and run-level deadline in §7.3.
- **`privileged: true`** enables docker-in-docker; the image must contain docker (§11.1).
- **Reserved job name**: `synth` (it is a check context, §13.2); synth errors on collision, alongside the existing job-name collision check.

### 4.3 Synth-time guardrails and lints

- **Secrets gating is enforced by the decider at dispatch** (§10.2, §12a) — the load-bearing check is control-plane code. Synth-time checking of `secretsAllowedRefs` survives only as fail-fast UX: synth runs repo-controlled code and can never be the enforcement point.
- **PR runs receive no secrets in v1, as a rule**: a PR run's identity is `refs/pull/N`, which the allowlist matcher can never match by construction (§12a).
- All job roles sit under the **mandatory deployment-level permissions boundary**.
- Lint: **secret masking is exact-match-only** — transformed secret values leak into logs.
- Lint: **implicit Docker Hub reference** (bare `node:22`) — recommend the `public.ecr.aws/docker/library/...` mirror.
- Cloud-synth lint: any `Trigger.cron` finer than the deployment's `pollCadence` warns; cron granularity degrades to the poll cadence (§6.4).
- Error: no resolvable `image`; `consumes` without matching `produces`; job-name collisions; reserved name `synth`; run-model `schemaVersion` newer than the control plane's.
- Synth makes **no registry or network calls**; image lints are string-level only.

---

## 5. Run model (synth output)

`millwright synth` emits one JSON document — the contract between definition, cloud orchestration, and local runner. Cloud synth lands it at `runs/…/<n>/in/model.json` (§9.3); local synth holds it in process. Shape unchanged from the convene draft (schemaVersion, repo, commit, workflows[] with triggers/concurrency/jobs[]; each job: image, compute, privileged, timeoutMinutes, steps with optional skipIf, secrets, produces/consumes, dependsOn, cache).

**`model.json` is a named privilege boundary.** It is authored inside the synth job, which executes repo-controlled code (§7.2): the control plane schema-validates it and treats every grant it requests as attacker-influenceable — requested IAM is materialized only by control-plane code (§10.2), capped by the mandatory boundary (§10.1), with secret grants only for allowlisted refs (§12a). The `(triggers, concurrency)` map is extracted into the per-ref registry **by control-plane code after validation** (§8.3), never by the synth job itself.

---

## 6. Triggering: polling architecture

### 6.1 Tier 1 — git protocol over SSH (resilient core)

EventBridge Scheduler (1-min rate, jitter window) → the non-VPC poller Lambda:

- **Transport: pure-JS `ssh2`**, exec `git-upload-pack 'owner/repo'` with `GIT_PROTOCOL=version=2`, authenticated with the repo's **read-only deploy key**. Proven live (ticket 016). Detect fallback by first pkt-line: without the env, babeld streams the protocol-v0 advertisement — fat but correct; parse it anyway.
- **Honest scaling statement**: the operating query is the full `refs/heads/*` + `refs/tags/*` namespace at ~65 B/ref — the response **scales with the watched repo's ref count** (hundreds of KB/tick on a 5,000-ref repo). Protocol v2 removes the capability advertisement and peeled-tag duplication, not the per-ref payload; ticket 016's 67 B figure was a single-ref best case. Connection reuse across ticks is the measured-later optimization 016 left unexercised.
- **Fan-out and overlap** (pinned): bounded intra-tick concurrency of **8–10 parallel `ssh2` sessions** (I/O-dominated; 50 repos ≈ 7–8 s/tick). Poller reserved concurrency = 1; Lambda timeout ≥ 2× `pollCadence`; a tick firing while the previous runs is throttled (self-throttling), with a counter/alarm on sustained overlap and last-tick duration reported by `doctor`. Growth path past N≈100: shard the schedule by repo prefix (documented, not built).
- **Ordering** (pinned): **emit-then-commit** — emit diff events to C3, then commit the new ref→sha map to C10. Commit-then-emit is ruled out by name (it silently drops pushes on a crash). Crash-window duplicates are absorbed by the launcher's content-derived dedupe (§7.1).
- **Deploy keys always** — the everyday path *is* the outage path. The App token never touches tier 1.
- **Ref-map compression is required v1 behavior** (not a plan): the 400 KB item cap is a certainty on large-ref repos, and the map is read+written per repo per tick.
- **Host keys**: pinned from GitHub's `/meta` endpoint into SSM at setup; compiled-in published fingerprints as day-one defaults; auto-reconcile-with-alarm on confirmed rotation, hard-fail otherwise; `millwright refresh-host-keys` as the manual hatch. The same pins serve the synth job's clone (§7.2).
- **Key handling**: batch-fetch via `GetParameters` on cold start; decrypted keys cached in memory while warm.
- **Default-branch discovery**: the `symrefs` HEAD answer already present in every `ls-refs` exchange — zero extra calls.

### 6.2 Tier 2 — PR polling (best-effort)

`GET /repos/{o}/{r}/pulls?state=all&sort=updated` with per-repo ETags, App-token authenticated (requires the App's **Pull requests: read** permission — present in C18); authenticated 304s don't count against the primary rate limit. 50 repos at 1-min polls worst-case ≈ 3,000 req/hr, inside the 5,000/hr budget. Cadence band 60–120 s; per-repo `prPolling` toggle.

### 6.3 Degradation

Quorum circuit breaker (≥3 repos' SSH transport failures ⇒ open; decaying canary); per-repo quarantine on "Repository not found"/key-auth rejection; backoff with jitter on tier-2 API errors. Latency floor and cost: §16.

### 6.4 Cron and manual dispatch

- **Cron**: the poller tick doubles as the cron clock, with correctness machinery (all blocking for v1 cron): per cron entry, a **`last-fired-minute`** attribute in C10; each tick computes the minutes in `(last-fired, now]` matching the expression and fires **at most the latest one** (bounded catch-up — no post-outage thundering herd). Deterministic event id `cron#<repo>#<wf>#<minute>` flows the standard dedupe item, cancelling double-fires exactly. Timezone is **UTC**, documented. Cron reads `Trigger.cron` from the repo's default-branch registry entry (guaranteed to exist by §8.3's bootstrap); cron is ref-less and always runs the default branch. `pollCadence` > 1 min degrades cron granularity to the cadence — synth warns (§4.3), docs state it.
- **Manual dispatch**: `millwright dispatch` puts a `dispatch` event on the bus under operator AWS credentials (source-conditioned, §7.1), carrying workflow, ref (resolved to a sha), and typed inputs. Uniform launcher path; no special lane.

---

## 7. Run orchestration

### 7.1 Run start

EventBridge rule → **launcher Lambda**, in this order (B1 pin — validation strictly precedes the dedupe write):

1. **Validate source and shape.** The bus resource policy restricts `PutEvents` by principal and `events:source`: poller role → `millwright.poller` only; operator CLI → `millwright.cli` only; job roles → `millwright.step` only. The launcher accepts `push`/`branch`/`tag` only from `millwright.poller`, and `dispatch`/`bootstrap` only from `millwright.cli`. Event source is part of trigger matching, not decoration. A forged push therefore requires the poller role's own credentials. (No cross-check against C10 — see §B1.)
2. **Dedupe** on the content-derived key `EVENT#<repo>#<ref>#<sha>#<kind>`, conditional put, **TTL 30 minutes**. Documented blind spot, accepted: a force-push *revert* to a sha already seen within the past 30 minutes coalesces into the earlier run. The dedupe item is a processing record: the run id is written onto it once created, so launcher retries resume idempotently instead of dropping the event.
3. **Match** event → workflows via the per-ref registry (§8.3); on registry miss with no default-branch fallback, start the **bootstrap synth-only execution** and replay (§8.3).
4. Atomically **increment the per-workflow run counter** → workflow-scoped run number (`ci#142`).
5. **Write the run record (PENDING).**
6. **Gate concurrency** (§8.4) — run proceeds, or is marked **QUEUED** in place.
7. Call `StartExecution` on the run executor.

### 7.2 Synth job — a named control-plane component with a trust boundary

The state machine's first step is a synth job on CodeBuild at the triggering commit. It executes repo-controlled code (`npm ci` install scripts, `workflows.ts`) and is specified accordingly:

- **Image**: a pinned public-ECR image carrying git+node (`public.ecr.aws/docker/library/node:22`, full variant), pinned **by digest per control-plane release**. The synth job is explicitly exempt from §11.1's image contract, which scopes to *user* jobs. This is millwright pinning a public image, not publishing one.
- **Tooling**: the synth CLI/compiler arrives as a **C13 secondary source**, exactly like the shim — the synth tooling is always the control plane's own version and is never resolved from the watched repo. The repo's `millwright-workflows` lib version is what the `schemaVersion` check governs.
- **Install contract**: working directory = repo root; entry point `millwright/workflows.ts`; package-manager discovery by lockfile (`package-lock.json` → `npm ci`; `pnpm-lock.yaml` → `pnpm install --frozen-lockfile`; `yarn.lock` → `yarn install --frozen-lockfile`; none → `npm install` + lint warning). Dependency install stays because "sharing = npm packages" is ticket-decided.
- **Clone**: via the repo's deploy key, host keys verified against the same SSM pins as the poller. For PR runs, one explicit extra fetch of `+refs/pull/N/head` — the PR head lives in the *base repo's* namespace, readable by the deploy key; no fork remote, no fork credential, ever (§13.1a).
- **Role** (in §10.3's inventory): read on the repo's deploy-key param + host-key pins + repo config param; `s3:PutObject` on the run's `in/` subprefix. **No DynamoDB access.**
- **Registry write is control-plane-side**: the state-machine step after synth reads `model.json` from S3, schema-validates it, writes the `REG#` entry, and reconciles job-role policies (§10.2). The synth job cannot touch the table — which closes the registry-overwrite vector at the root.
- Outputs land at the run's `in/` prefix: `model.json` and the packaged `source.tar.gz`.
- *Escape hatch (pre-approved)*: synth needs no docker — it can move to CodeBuild Lambda compute mode if latency ever warrants; measured provisioning (2–7 s, §16) means it currently doesn't.

**Bootstrap (synth-only) executions**: the same machine with a stop-after-synth flag, idempotently keyed by `(repo, ref, sha)` — used by §8.3's registry bootstrap and `repo add` priming. They validate the model, write the registry entry, report the `millwright / synth` check, dispatch no jobs.

### 7.3 Decider loop

**Dispatch-on-completion.** One generic Step Functions Standard machine loops the decider Lambda:

- The decider reads `model.json` from S3 (cached in-process across iterations) + job states from DynamoDB, treats **`BatchGetBuilds` as authoritative for terminal job states** (table job rows are a projection — a poisoned row can never flip a failing sibling green), fires `StartBuild` for every job whose deps just completed, then waits on the task token.
- **Token protocol** (Reading A, pinned): the decider writes the current iteration's task token onto the Run item before entering the wait. The token-wait state carries **`TimeoutSeconds: 60` with a `Catch` on `States.Timeout`** back into the decider, which reconciles via `BatchGetBuilds`. **No component sends `SendTaskHeartbeat`; no heartbeat sender exists.** The build-events handler is the low-latency wake; the timeout is the safety net that also catches completions landing between token generations. Senders (build-events handler, CLI cancel) read the token from the Run item, `SendTaskSuccess` best-effort, and swallow `TaskTimedOut`/`InvalidToken` — wakes are idempotent because the decider re-reads `cancelRequested`, job states, and CodeBuild ground truth on every entry.
- **Build→run mapping**: a `BUILD#<build-id>` item written by the decider at dispatch, carrying run/job identity, short TTL past run terminality. No GSI.
- **Bounded by contract**: per-job **total-attempt cap, default 3**, model-overridable. **Run-level wall-clock deadline, default 24 h**, model-overridable up to C11's 36 h ceiling, enforced by the decider's clock and **anchored to the original run start across carry-overs** — a stuck run dies a managed death (jobs TIMED_OUT, run FAILED, checks reported) before the Step Functions history ceiling can kill the execution unmanaged.
- **Carry-over re-execution**: when an execution approaches its iteration budget, its terminal state `StartExecution`s a fresh execution of the same machine, resuming from table state (token on the Run item, CodeBuild as ground truth). The 25,000-event history cliff becomes a non-event. The §8.4 sweep repairs group slots; it does not resurrect executions — the caps above are what prevent dead executions from existing.
- The decider is a pure library reused in-process by the local runner (§14).

### 7.4 Per-job dispatch

One `StartBuild` per job on the single CodeBuild project, with per-run overrides: image, `computeTypeOverride`, **`environmentTypeOverride`** (the ARM↔x86 switch), **`imagePullCredentialsTypeOverride: SERVICE_ROLE`** (without it, job-role ECR grants are inert under the `CODEBUILD` default), privileged mode, env, timeout, service role (the job's stable role variant, §10.2), inline buildspec. The buildspec is rendered by a **shared control-plane library** (used by the synth step, the decider, and the local runner): synth emits the step list and declared env names; the control plane renders the prelude, shim-wrap, and artifact/cache paths — repo code never authors the buildspec that wraps it. CodeBuild's built-in `QUEUED` phase (+ `queuedTimeoutInMinutes`) is the only queue.

### 7.5 Status algebra

- Job states: PENDING → QUEUED/PROVISIONING → RUNNING → SUCCEEDED | FAILED | TIMED_OUT | CANCELLED | SKIPPED.
- Run states: **PENDING and QUEUED are first-class**, then RUNNING → SUCCEEDED | FAILED | CANCELLED (including `reason: superseded`).
- Transitive dependents of a failed job → SKIPPED with `reason: upstream_failed` (distinct from `reason: skip_if`); independent branches run to completion.
- Run FAILED if any job FAILED/TIMED_OUT (including the run-deadline path); CANCELLED if cancelled; SUCCEEDED iff every job SUCCEEDED or was SKIPPED via guard. No fail-fast in v1 (deferred); no soft-fail (out of scope).

### 7.6 Cancellation

**Cancellation is decider input, not an outside kill.** The CLI writes `cancelRequested` on the run record and sends the task token (read from the Run item, stale-safe per §7.3); the decider `StopBuild`s in-flight builds, marks non-terminal jobs CANCELLED, marks the run CANCELLED, exits cleanly. `StopExecution` is documented break-glass only. Local Ctrl-C sets the same flag through the same path.

### 7.7 Rerun

`millwright runs rerun <run>` creates a new run (fresh number, `rerunOf`) from the stored job model — no re-synth. `--failed` reruns FAILED/TIMED_OUT/CANCELLED jobs plus their SKIPPED dependents: the **launcher** prefix-copies succeeded jobs' `out/<job>/` subtrees into the new run's prefix (the launcher role carries the S3 copy grants) and the decider seeds those jobs terminal SUCCEEDED with `reusedFrom`. Nothing failed → `--failed` rejects. Reruns gate through concurrency groups like any other run.

### 7.8 Step-level status

**The shim does not write the table.** It emits step events via `events:PutEvents`, confined by the job role's grant to `source: millwright.step`; the step-events writer (C19) writes step rows, idempotent on `(run, job, step-index)`. Writer partitioning is mechanically true: **launcher** (counter, run create, dedupe/processing records, group claims, rerun prefix-copy), **decider** (run + job rows, group hand-off, check desired-state, `BUILD#` items), **C19** (step rows), **reporter** (check reported-state), **CLI** (`cancelRequested` + task-token send). Job roles have **no DynamoDB access at all**. Honest residual, stated: a job can emit step events claiming another job's identity *in its own run* — step rows are therefore **display-plane, never decision-plane** (terminal authority is `BatchGetBuilds`, §7.3).

---

## 8. Concurrency

### 8.1 Primitive

Opt-in concurrency groups; membership means at most one run executes at a time. No group declared → unlimited concurrent runs. No numeric limits in v1.

### 8.2 Keys, policies, queueing

Unchanged from the convene draft: static strings + `${ref}` / `${workflow}` / `${repo}` / `${event}` tokens, launcher-evaluable pre-synth; deployment-global scope; `queue` (default) and `supersede` policies; pending slot of one; superseded/replaced runs CANCELLED with `reason: superseded`, rerunnable; uniform gating for poll/cron/dispatch/rerun, no bypass flag; local runs don't enforce; CodeBuild account quota surfaced by `doctor`, not managed.

### 8.3 The per-ref registry

Every successful synth's `(triggers, concurrency)` map is written to DynamoDB keyed by ref — **by control-plane code after model validation** (§7.2), never by the synth job. The launcher matches an event against its ref's entry, falling back to the default branch's map for never-synthed refs.

- **Bootstrap on registry miss**: when an event arrives for a `(repo, ref)` with no registry entry and no default-branch fallback, the launcher starts a **synth-only execution**, idempotently keyed by `(repo, ref, sha)`, then **replays the original event** against the resulting map. The replayed run reuses the bootstrap's stored model rather than re-synthing. The bootstrap reports the `millwright / synth` check — a first push is visible, never silent.
- **`REG#` rows are exempt from the 90-day TTL**: they are configuration indexes, not run history, refreshed by every successful synth.
- **`repo add` primes**: after writing config and installing the deploy key, the CLI emits a `bootstrap` event (`source: millwright.cli`) for the default-branch head (resolved via `ls-refs` with the fresh key), so onboarding ends with a primed registry and a visible synth check; on an empty repo it prints that triggers activate on first push.
- **`doctor` fails — not warns** — when a configured repo shows polling activity but no default-branch registry entry, naming the bootstrap remedy.

Consequences (unchanged): branch config changes take effect from that branch's second run; a new branch's first push uses default-branch config.

### 8.4 Mechanics

A `GROUP#<key>` item holds the running and pending run ids; the launcher claims/replaces the pending slot with conditional/transactional writes (queued runs' records exist at queue time, QUEUED). On run completion the decider clears the running slot and starts the pending run (decider and sweep hold `states:StartExecution`). The sweep detects groups whose running run is terminal but whose slot never cleared, and starts the pending run.

---

## 9. Data stores and schemas

### 9.1 State table (DynamoDB, single-table, on-demand)

TTL 90 days on all items **except `REG#` rows** (`retention.metadata`).

| Item | PK | SK | Notes |
|---|---|---|---|
| Run counter | `WF#<repo>#<workflow>` | `COUNTER` | Atomic increment by launcher. |
| Run | `WF#<repo>#<workflow>` | `RUN#<inverted zero-padded number>` | Status (incl. PENDING/QUEUED), trigger kind, ref, sha, timestamps, `cancelRequested`, `rerunOf`, `reason`, **current task token**, original-start timestamp (deadline anchor). |
| Job | `RUN#<repo>#<workflow>#<number>` | `JOB#<name>` | Projection of CodeBuild state (authority: `BatchGetBuilds`); build id/ARN, log stream, timings, `reusedFrom`, skip reason. |
| Step | `RUN#<repo>#<workflow>#<number>` | `JOB#<name>#STEP#<index>` | Written by C19 from shim events; display-plane only. |
| Event dedupe / processing record | `EVENT#<repo>#<ref>#<sha>#<kind>` | `-` | Conditional put; TTL 30 min; run id written on creation for idempotent launcher retries. |
| Build mapping | `BUILD#<build-id>` | `-` | Run/job identity for the build-events handler; short TTL past terminality. |
| Concurrency group | `GROUP#<key>` | `-` | `running`, `pending`; conditional/transactional writes. |
| Registry | `REG#<repo>` | `REF#<ref>` | Written by control-plane code post-validation; `schemaVersion`, per-workflow `{triggers, concurrency}`. **TTL-exempt.** |
| Check state | `CHECK#<repo>#<sha>` | `CTX#<context>` | `desired`, `reported`, `check_run_id`, **`ownerRun`**, backoff state, abandoned flag (§13.2). |

**The state table is never a credential store** — it is not CMK-encrypted and is the most widely readable item in the system (§13.1).

### 9.2 SSM config plane (`/millwright/<name>/…`)

All SecureStrings under the dedicated CMK; two-gate posture (`ssm:GetParameter`/`GetParameters` **and** `kms:Decrypt`).

| Path | Type | Contents |
|---|---|---|
| `/millwright/<name>/manifest` | String | Deployment manifest; the CLI's discovery root. |
| `/millwright/<name>/repos/<repo>/config` | String (JSON) | `secretsAllowedRefs`, `prPolling`, `forkPrPolicy` (default off), `ecrPullRepos` (private-ECR pull allowlist, §10.2). Written by `repo add/update` under operator IAM. |
| `/millwright/<name>/repos/<repo>/deploy-key` | SecureString | Ed25519 private key (~400 B; SSM standard tier is free — Secrets Manager would 10x the polling stack at 50 repos). |
| `/millwright/<name>/github/app` | SecureString | App id + private key PEM from the manifest exchange. |
| `/millwright/<name>/github/host-keys` | String | Pinned SSH host keys, seeded from `/meta`. |
| `/millwright/<name>/secrets/<scope>/<NAME>` | SecureString | Workflow secrets; `<scope>` defaults to the repo (§4.2). |

Existing Secrets Manager ARNs are accepted as passthrough references; millwright itself stores nothing in Secrets Manager.

### 9.3 S3 layout (artifact/cache bucket)

```
runs/<repo>/<workflow>/<number>/
    in/                          control-plane inputs — synth role writes; job roles read-only
        model.json
        source.tar.gz
    out/<job>/<artifact-name>/…  each job role writes ONLY its own out/<job>/ subtree
cache/<repo>/<key>               keyed dependency-cache objects (repo-scoped trust, §10.2)
```

Jobs never clone; they pull `source.tar.gz` from `in/`. Poisoning is confined to a job's own declared outputs — which is just "producing artifacts." Rerun `--failed` prefix-copies succeeded jobs' `out/<job>/` subtrees. Retention via lifecycle rules. CodeBuild's native artifacts and S3 cache modes are unused.

### 9.4 Polling table

Per-repo items: last-seen ref→sha map (**compressed — required**), tier-2 ETags, cron `last-fired-minute` entries, quarantine marker; one circuit-breaker item. Never queried by the CLI (the launcher reading it is permitted — though after §B1 it no longer needs to).

---

## 10. IAM model

### 10.1 Boundary

Every role millwright creates for user jobs sits under the deployment-level **permissions boundary** — a **required** construct prop (§3.2; construct throws without it; explicit `Boundary.NONE` sentinel is the only opt-out). Definitions are repo-editable, so the boundary is the operator's hard ceiling on everything a `model.json` can request.

### 10.2 Job roles — stable per (repo, workflow, job), two variants

Per-run role creation is **dropped** (council fiat under §18's flagged design pass): the repo's own spike (`prototypes/codebuild-provisioning-spike/measure.sh:82-88`, a 12×5 s retry loop "while the fresh role propagates") demonstrates the IAM eventual-consistency wall; the quota arithmetic (~500 standing roles from §16's own example against the 1,000-role default) and CreateRole-on-hot-path throttling stood unrebutted. `StartBuild` has no session-policy channel (`serviceRoleOverride` takes a bare role ARN), so the STS-session alternative is ruled out and must not be re-derived.

**Adopted design** (incorporating §B3):

- **Two stable variants per (repo, workflow, job)**: *full-grants* and *no-secret-grants*. Deterministic names under the `mw-*` namespace, truncated/hashed to IAM's 64-char limit, boundary-attached, tagged.
- **The decider selects the variant at dispatch** by matching the run's ref against `secretsAllowedRefs` (§12a). PR refs (`refs/pull/N`) are structurally unmatchable → always no-secret. Unset allowlist → no ref receives secrets (fail-closed).
- **The no-secret variant contains nothing model-derived.** Grants: S3 read on `runs/<repo>/<wf>/*/in/*` and run-wide artifact read, write on `runs/<repo>/<wf>/*/out/<job>/*`; cache get/put on `cache/<repo>/*` with prefix-conditioned `s3:ListBucket`; `events:PutEvents` conditioned to `source: millwright.step`; private-ECR pull on the repos in the repo config's **`ecrPullRepos`** allowlist (operator-gated — no new burden, since private pull already requires the operator to edit the ECR repository's resource policy; `doctor` best-effort checks it). **No DynamoDB access. No deploy-key access — an explicit negative grant.** Untrusted-ref synths therefore never mutate any role.
- **The full variant adds**: `ssm:GetParameters` (plural — required by CodeBuild's `env.parameter-store` resolution) on exactly the declared secret params + `kms:Decrypt` on the CMK; `secretsmanager:GetSecretValue` on declared passthrough ARNs. It is **created/updated only from validated models of allowlisted refs**, by the control-plane post-synth step. The decider verifies a stored policy hash against the run's model at dispatch and idempotently updates on mismatch, retrying `StartBuild` through propagation (bounded, ~60 s) — the wait lands only on grant-changing runs of trusted refs.
- **Accepted, stated losses**: cross-run isolation within one workflow (run N can read run M's artifacts — the threat model already executes repo code); cache-write trust is repo-scoped (exact-key write scoping was illusory: any branch computes the shared key legitimately); trusted refs with differing models churn the full variant's policy (rare; bounded by the dispatch-time reconcile).
- **Housekeeping**: the sweep deletes role pairs whose (workflow, job) no longer appears in any registry entry after 30 days. Quota pressure is structurally gone; `doctor` still reports role count.

### 10.3 Control-plane roles (complete inventory)

- **Poller**: `GetParameters` on deploy keys + host-key pins + repo configs; C10 read/write; `events:PutEvents` conditioned to `source: millwright.poller`.
- **Launcher**: state-table writes (its §7.8 partition), `states:StartExecution`, S3 get/copy/put across `runs/<repo>/<wf>/*` for rerun prefix-copy.
- **Synth job role**: per §7.2 — deploy-key + host-key-pin + repo-config reads, `s3:PutObject` on the run's `in/` prefix. No DynamoDB.
- **Decider**: state table (its partition), `s3:GetObject` on `runs/…/in/*`, `StartBuild`/`StopBuild`/`BatchGetBuilds`, role reconciliation with **escalation guards**: `iam:CreateRole`/`iam:PutRolePolicy` carry an `iam:PermissionsBoundary` condition pinned to the boundary ARN; `iam:PassRole` scoped to the `mw-*` namespace with `iam:PassedToService: codebuild.amazonaws.com`. A decider driven by a hostile `model.json` cannot mint or pass an unbounded role.
- **Build-events handler**: state table job-row updates via `BUILD#` lookup; `states:SendTaskSuccess`/`SendTaskFailure`.
- **Step-events writer (C19)**: step-row writes only.
- **Reporter**: state table + stream, App token minting (reads App PEM); sole owner of check reconciliation.
- **Sweep**: group repair (`states:StartExecution`), stale-role housekeeping (same IAM conditions as the decider).
- **CLI (operator IAM)**: `cancelRequested` write, `states:SendTaskSuccess`, `events:PutEvents` conditioned to `source: millwright.cli`.

All control-plane roles are fixed at deploy time; only job-role *policies* change, and only via the guarded paths above.

### 10.4 Provenance note

Tickets 004 ("dispatcher materializes roles") and 008 ("synth generates the role") contradicted each other; resolved for the control plane, with 008's reading explicitly ruled out — synth runs repo code (§17 amendment 8). The per-run lifecycle sketched in the convene draft's §10.4 is superseded by §10.2 above.

---

## 11. Job execution environment

### 11.1 Image model

Unchanged in substance: contract is Linux + POSIX shell, nothing more; images never millwright-aware; git and node **not** required in *user job* images (the synth job is the explicit exemption, §7.2); `image` required with the cascade and no default; millwright publishes no images; image is the toolchain (pinning = tag pinning); `image` is a plain docker-run string, lints string-level only; privileged jobs carry the documented contract that the image contains docker (blessed choice: `public.ecr.aws/docker/library/docker:<ver>-dind`). **Private-ECR images additionally require** the repo to appear in the repo config's `ecrPullRepos` allowlist *and* the ECR repository resource policy to permit the job role (§10.2) — documented next to the "small custom image in your own ECR" recommendation.

### 11.2 Generated buildspec: prelude, shim, steps

Rendered by the shared control-plane library (§7.4). Shape per job: (1) prelude — if `privileged: true` and no live docker socket, auto-start `dockerd` (socket-liveness guard makes it a local no-op); (2) unpack `source.tar.gz` from `in/`; (3) shim delivery via S3 secondary source (bind-mounted locally); (4) cache restore — exact key, else `restoreKeys` prefix fallback (needs the prefix-conditioned `s3:ListBucket`, granted); (5) steps, shim-wrapped (start/end/status/skip via step events, `skipIf` → SKIPPED); (6) artifact upload to `out/<job>/`, cache save (skipped on exact hit). Secrets arrive pre-step-1 via CodeBuild-native `env.parameter-store` / `env.secrets-manager` blocks — env vars with exact-match masking (a repo-authored reference to an *undeclared* parameter fails closed on the job role's missing grant; the reason rendering is control-plane-side is preamble integrity, not parameter security). File-shaped secrets are v1'd by a step writing the env var to disk.

### 11.3 Compute

On-demand EC2: environmentType **`ARM_CONTAINER`**, computeType **`BUILD_GENERAL1_SMALL`** default; x86 opt-in maps to `LINUX_CONTAINER` via `environmentTypeOverride`. (The `arm1.*` names are reserved-fleet naming and are purged — reserved capacity is rejected: it violates zero-idle.) Measured floor (ticket 012, 24 builds): PROVISIONING 2–7 s across the matrix.

---

## 12. Artifacts, caching, and secrets gating

- **Artifacts**: declared `produces`/`consumes`, synth-checked, doubling as the DAG; stored under `out/<job>/` with write confinement (§9.3, §10.2); retention via lifecycle rules.
- **Dependency caches**: GHA-style keyed semantics (`hashFiles`, `paths`, `restoreKeys`); exact hit skips save; lifecycle eviction. Write trust is repo-scoped (§10.2). CodeBuild native cache unused.
- **Docker layer caching**: outside the keyed system in v1; buildx with an ECR/S3 backend is a job-level technique; `DockerCache` construct deferred.

### 12a. `secretsAllowedRefs` — the matcher and the gate

- **Dialect**: patterns match the **short ref name** as pushed (`main`, `release/1.2`, tag names likewise), **anchored at both ends**; `*` is the only metacharacter and crosses `/`; no implicit prefix/substring behavior. `main` matches exactly `main` — never `mainline`. The matcher ships with a test table.
- **Enforcement point**: the **decider, at dispatch**, via variant selection (§10.2). Synth-time checking is fail-fast UX only — synth executes repo code and can never be the enforcement point.
- **Default**: unset means **no ref receives secrets**. The shortest onboarding command is the safe one.
- **PR refs are structurally unmatchable** (`refs/pull/N` never short-name-matches), making "no secrets on PR runs" a v1 rule, not an emergent property.
- **Honest limit, documented loudly**: an allowlisted ref *name* is only as strong as GitHub-side protection of that namespace — `--secrets-refs release/*` hands secrets to anyone who can push `release/anything` unless a ruleset protects it. `doctor` warns where it can read ruleset state; otherwise the doc warning is the control.

---

## 13. GitHub integration

### 13.1 Auth

- **Per-repo read-only Ed25519 deploy keys** carry all git-protocol work — tier-1 polling and the **synth job's** clone (user jobs never clone and have no deploy-key access, §10.2). Generated by `repo add`, stored in SSM under the CMK, installed via the App's Administration permission (or printed for manual add).
- **Per-deployment GitHub App** carries REST-only work: check runs, tier-2 PR polling. Manifest-flow creation by `millwright setup`. Permissions: Contents: read, Checks: write, Commit statuses: write, **Pull requests: read** (required by the tier-2 `pulls` endpoint), Administration: write. Rate limit ≥5,000 req/hr per installation, cap 12,500. **Installation tokens are minted on demand and cached in memory only, per consumer Lambda** — never in DynamoDB, never as rotated secrets. If a durable cache is ever demonstrated necessary, the pre-approved shape is a CMK-encrypted blob in the *polling* table with item TTL = token expiry; not v1.
- **Administration: write stays, blast radius documented**: App permissions are per-App, not per-call, so post-onboarding reduction would need a second App — not v1 complexity. A stolen App PEM permits installing an attacker deploy key on every watched repo (persistent private-code read); that is why the PEM sits behind the two-gate SSM+CMK posture. PAT mode is the tighter-scoping alternative.
- **Fine-grained PAT fallback** (`setup --pat`): commit statuses instead of check runs, same context names, so branch protection works identically.

#### 13.1a Fork PRs and PR shas

- **PR runs build the head sha, never the merge sha** (the merge ref exists only via the REST API — using it would couple tier 1's resilience to tier 2). Fetch mechanism: `+refs/pull/N/head` from the base repo's namespace via the deploy key (§7.2).
- **PR runs receive no secrets in v1** (§12a).
- **Fork PRs: repo-config toggle, default off** — no runs for fork-authored PRs until the operator opts in via `repo update`. Rationale stated: even secret-less, fork code executes in the synth job, which holds the repo's deploy key; exfiltration is persistent private-code access. Same-repo PRs run by default (the pusher already had write). Runs key off the PR ref and head sha, never the fork's branch name, dissolving cross-fork name collisions.

### 13.2 Check reporting

- **Granularity**: one check per job, named `<workflow> / <job>` (synth-validated names ⇒ stable contexts), plus one **workflow-scoped synth check `<workflow> / synth`** per run — created `in_progress` at run start (the run's workflow is known pre-synth), completed on synth success (per-job checks then batch-create as `queued`) or failed with the error in its summary, so a broken `workflows.ts` is always visible. Bootstrap-only executions report the repo-level **`millwright / synth`** context (single idempotent writer per sha). `synth` is a reserved job name. Docs recommend requiring the gating workflows' `<workflow> / synth` contexts in branch protection. PAT mode degrades to commit statuses with identical context names.
- **Ownership under concurrency**: the check item gains **`ownerRun`**; the rule is **the newest run owns the context**. The decider's desired-state upsert is conditional on its run number ≥ the stored owner's; a lower-numbered run's write is silently dropped (its jobs still render fully in `runs show`). Same-or-newer writes carry `check_run_id` forward so the reporter updates one check run rather than minting duplicates. Contexts embed the workflow name and synth checks are workflow-scoped (§B2), so owner comparison is always within one workflow's number sequence — total where used.
- **Architecture**: desired-state reconciliation via DynamoDB Streams (happy path) with the 1-min sweep for unconverged items — both owned by the reporter (C8). The reporter posts the *latest* desired state; outage replay coalesces to one call per check.
- **Degradation**: per-item exponential backoff (1 m → 15 m cap) honoring `Retry-After`; unconverged after 7 days → abandoned (visible in `runs show`); 90 d TTL clears it. Duplicate creates from crash windows are benign. A late flush is still true for its sha and can never bless a newer commit.
- **Scope**: every cloud run reports to its commit sha — checks attach to shas, so PR reporting never depends on tier-2 polling. Local runs never report. Budget ≈ 1,500 calls/day vs 5,000/hr.
- **Content**: job-check markdown carries run number, per-step conclusions/durations, failed step with last log lines, triage command; details URL deep-links to CloudWatch. PAT mode: ~140-char description + URL.
- **V1 omissions**: no file/line annotations; no check-run re-run button (requested actions are webhook-delivered; rerun stays in the CLI).

---

## 14. Local execution

**`millwright run <wf>` is always local; `millwright dispatch <wf>` is always cloud.** Shared core, two thin hosts: the pure decider library + step shim in-process against `Executor` (`StartBuild` ↔ `docker run`) and `StateSink` (DynamoDB ↔ `.millwright/runs/local-N.json`). Same DAG logic, SKIPPED semantics, terminal states; Ctrl-C sets `cancelRequested` through the same path. The convene draft's parity table stands with one downgrade: the image pull/auth row reads "cloud pulls need the `ecrPullRepos` config entry + ECR repository resource policy; local uses the user's own docker config." Inner loop (`--job`, `--with-deps`, artifact reuse, `--as-tag`, typed-input prompting, host-socket mounting for privileged, concurrency carried-not-enforced) unchanged.

---

## 15. CLI command surface

```
Setup & ops
  millwright init
  millwright setup [--pat]
  millwright repo add <owner/repo> [--secrets-refs <refs>] [--no-pr-polling]
                     [--fork-prs <on|off>] [--ecr-repos <arns>]
                                           write repo config, mint+install deploy key,
                                           emit bootstrap event (primes the registry)
  millwright repo update <owner/repo> [--secrets-refs <refs>] [--pr-polling <bool>]
                     [--fork-prs <on|off>] [--ecr-repos <arns>]
  millwright repo list | repo remove <owner/repo>
  millwright doctor                        verify chain: SSM manifest, App creds (incl.
                                           per-repo pulls probe), deploy keys, poller
                                           ticking + last-tick duration; FAIL on missing
                                           default-branch registry entries; report
                                           CodeBuild concurrency + IAM quotas; best-effort
                                           ECR resource-policy and ruleset checks
  millwright refresh-host-keys
  millwright secrets set <name> [--scope <scope>]

Definition
  millwright synth

Execution
  millwright run <wf> [--job X [--with-deps]] [--clean] [--platform <p>]
                 [--secrets-file <path>] [--input k=v ...] [--as-tag <tag>]
                 [--parallel N]            always local
  millwright dispatch <wf> [--ref <ref>] [--input k=v ...]   always cloud

Observability
  millwright logs [-f] [<run>] [--job <name>] [--failed] [--full]
  millwright runs list [--workflow <wf>] [--ref <ref>] [--status <s>]
  millwright runs show [<run>]
  millwright runs rerun <run> [--failed]
  millwright runs cancel <run>
```

Run identity (`ci#142`), latest-run defaults, no web UI, polled `GetLogEvents` tail (~2 s), and retention knobs unchanged from the convene draft. Setup flow: `init` → plain `cdk deploy` → `setup` → `repo add` per repo (ends with a primed registry and a visible synth check) → `doctor`.

---

## 16. Latency and cost expectations

| | Figure | Source / assumptions |
|---|---|---|
| Push → detection | ~30–90 s typical, ~2 min worst | ticket 002; holds under §6.1's bounded fan-out |
| Poller per tick | ~7–8 s at 50 repos, 10-way fan-out | c5 re-derivation; binding constraint is wall-clock, not dollars |
| CodeBuild PROVISIONING | 2–7 s across the v1 matrix | ticket 012, measured |
| Push → first log line | "typically under two minutes" | ticket 012 |
| Polling stack | ~$0.80–2.40/mo at 10–50 repos | assumes moderate ref counts; large-ref repos add DynamoDB I/O for the compressed ref map |
| Step Functions | ~4–6 transitions/iteration ≈ tenths of a cent per typical run; ~$0.20/day pinned at the caps | c14 |
| CMK | ~$1/mo | ticket 008 |
| Compute at 100 runs/day × 5 min | ~$51/mo on ARM small on-demand | ticket 001; re-verified |
| Per-build minute rounding | +5–15% at typical job lengths | ticket 001 |
| Concurrent-start bursts | intermittent 30–40 s QUEUED; queue, don't fail | ticket 012 |

---

## 17. Amendments log — contradictions resolved (later decision wins)

Original seven (SSH+deploy keys over HTTPS+App token; SSM over Secrets Manager; deploy-key mint at `repo add`; secrets path under the deployment prefix; the per-ref registry; native cache unused; durable check queue satisfied structurally) — unchanged. Council-added:

8. **Job-role creation owner**: ticket 004 ("dispatcher materializes roles") vs ticket 008 ("synth generates the role") — resolved for control-plane code; 008's reading explicitly ruled out (synth runs repo code). Superseded in mechanism by §10.2's stable roles.
9. **`permissionsBoundary`**: ticket 004 accepted repo-resident definitions *conditioned on* the boundary; ticket 014 demoted it to an optional knob. Restored as the one required prop (§3.2).
10. **Buildspec generator**: ticket 004's "synth emits buildspecs" drift resolved — synth emits step lists; the shared control-plane library renders the buildspec (§7.4).
11. **Job source**: ticket 003/011's "deploy keys carry job source cloning" corrected — only the synth role reads deploy keys; jobs consume `source.tar.gz` (§13.1).
12. **`ls-refs` headline**: ticket 016's 67 B figure restated as the single-ref best case; the operating response scales with ref count (§6.1).

## 18. Spec-filled gaps — dispositions

1. **Per-run job-role lifecycle** — the flagged design pass was held by the council: per-run creation dropped, stable two-variant roles adopted (§10.2). Closed.
2. **Cron firing** — kept, with blocking correctness machinery (§6.4). Closed.
3. **Manual-dispatch transport** — CLI `PutEvents` under operator credentials, source-conditioned (§7.1). Closed.
4. Naming fills (GROUP/REG/CHECK/BUILD/EVENT rows, SSM paths, S3 prefixes, `source.tar.gz`, `repo list/remove`) — confirmed as spec-level naming; the schema tables in §9 are the contract.

## 19. Deferred (fog) and out of scope

**Deferred**: fail-fast; GHA YAML importer; notifications & badges; run web UI; `SecretFile`; `DockerCache`; opportunistic webhook fast-path (would carry check re-run buttons); check-run annotations; concurrency extensions (numeric limits, full FIFO, `reject`, dispatch bypass); tier-1 observation of `refs/pull/*` via `ref-prefix`; durable installation-token cache (pre-approved shape in §13.1); schedule sharding past N≈100 repos; connection reuse across poll ticks; per-run role layering for jobs that ever need cross-run isolation.

**Out of scope**: multi-tenancy / millwright-as-a-service; code hosting and PR/review UX; webhook-*dependent* triggering; soft-fail / allow-failure jobs.

## 20. Council revision log

- **c1** — registry bootstrap-on-miss with event replay; `REG#` TTL-exempt; `repo add` primes; `doctor` fails on missing default-branch entries.
- **c2** — synth job named and scoped: pinned image, C13-delivered tooling, lockfile-discovery install contract, no table access; `model.json` a named trust boundary.
- **c3** — shim off the table (step events via bus + C19); `BatchGetBuilds` authoritative; S3 `in/`/`out/<job>/` split; LeadingKeys language deleted.
- **c4** — per-run roles dropped; stable per-(repo, workflow, job) two-variant roles; decider IAM escalation guards; 004/008 contradiction logged.
- **c5** — bounded fan-out, reserved-concurrency-1 overlap policy, emit-then-commit pinned; `ls-refs` numbers restated; ref-map compression required.
- **c6** — token on the Run item; caught-timeout wake (no heartbeat sender); stale-send swallow; `BUILD#` mapping item.
- **c7** — content-derived dedupe key, TTL 30 min; `PutEvents` a named boundary (superseded in mechanism by §B1's source-conditioned policy).
- **c8** — cron `last-fired-minute` bookkeeping, bounded catch-up, UTC, cadence lint, `symrefs` default-branch discovery.
- **c9** — App gains Pull requests: read; token cache memory-only; Administration: write kept with documented blast radius.
- **c10** — PR runs build head sha via `refs/pull/N/head`; no secrets on PR runs; fork PRs default-off toggle.
- **c11** — `ownerRun` newest-run-wins conditional upsert (extended by §B2 to workflow-scoped synth checks).
- **c12** — anchored glob dialect; enforcement at dispatch via variant selection; fail-closed default; repo-scoped secret paths.
- **c13** — `permissionsBoundary` required, construct throws, `Boundary.NONE` sentinel; mint-path IAM conditions.
- **c14** — caught-timeout reading pinned; attempt cap 3; 24 h run deadline (original-start anchored); carry-over re-execution; SFN cost line.
- **c15** — launcher owns rerun copy; launcher sequence fixed; model read from S3; shared buildspec renderer; deploy-key text corrected; role inventory completed; CodeBuild naming/override/grant details corrected.

<!-- council: {"agent":"cto","phase":"final"} -->
