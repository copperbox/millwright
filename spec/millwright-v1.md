# Millwright v1 — Implementable Specification

**Status**: v1 spec, assembled 2026-08-09 from the resolutions of wayfinder tickets 001–016.
**Provenance**: every decision below traces to a closed ticket on the
[wayfinder map](../wayfinder/map.md); §17 logs where later decisions amended earlier ones,
and §18 flags the small gaps this spec filled that no ticket decided. Nothing else is new.

---

## 1. What millwright is

Millwright is a **single-tenant, open-sourceable CDK application that replaces GitHub
Actions *execution*** with polling-driven CI/CD running in your own AWS account. GitHub
remains the source of truth for code and collaboration — millwright does no git hosting
and no PR/review UX.

**Framing invariants** (bound every section below):

- **No webhook dependency.** Triggering is poll-driven, in two tiers:
  - **Tier 1 (resilient core)**: git-protocol-observable events — push / branch / tag —
    via SSH `ls-refs` polling, plus manual dispatch and cron. These work whenever
    GitHub's git layer is up, even when the REST API, Actions, and webhooks are down.
  - **Tier 2 (best-effort)**: PR events via GitHub REST polling. Degrades when the API
    degrades; accepted and explicit.
- **Workflows are code, CDK-style**: TypeScript constructs in the watched repo,
  synthesized to a declarative run model at the triggering commit. No GitHub Actions
  YAML compatibility in v1.
- **The exact workflow runs locally without pushing** (`millwright run`), sharing the
  cloud's decider and step shim.
- **Single-tenant**: each team deploys millwright into their own AWS account. No
  multi-tenancy anywhere; no hardcoded account assumptions.
- **As serverless as possible**: minimize idle cost and ops burden. The design's only
  standing costs are a KMS CMK (~$1/mo) and the polling Lambda (~$1–3/mo).

---

## 2. Component inventory

Everything deploys from one CDK construct (`new Millwright(stack, props)`, §3). External
to AWS: one GitHub App per deployment, one read-only deploy key per watched repo.

| # | Component | Kind | Role |
|---|---|---|---|
| C1 | Poll tick | EventBridge Scheduler, `rate(1 minute)` + jitter window | Drives C2. Cadence is the `pollCadence` construct prop. |
| C2 | **Poller** | Lambda, zip-packaged, **non-VPC** | Per tick: SSH `ls-refs` every configured repo (tier 1), ETag'd PR polling (tier 2), diff against C10, emit events to C3. Carries pure-JS `ssh2` and the pkt-line/`ls-refs` parser. Non-VPC is load-bearing: NAT (~$32/mo) would dominate the stack's cost. |
| C3 | Event bus | EventBridge bus | Carries `push` / `branch` / `tag` / `pr` / `cron` / `dispatch` events. |
| C4 | **Launcher** | Lambda | Consumes C3 events: dedupes (conditional put on event id), matches events → workflows via the per-ref registry (§8.3), gates concurrency groups (§8.4), allocates run numbers, writes run records, calls `StartExecution` on C5. |
| C5 | Run executor | Step Functions **Standard** state machine, deployed once (generic) | Executes one run: synth job first, then loops the decider (C6) with `waitForTaskToken` (~30 s heartbeat). Never on the per-poll path — on-change only. |
| C6 | **Decider** | Lambda wrapping a **pure library** | `decide(jobModel, states, cancelRequested) → actions`. Reads job model + states, fire-and-forgets `StartBuild` per ready job, handles retries/timeouts/cancellation/SKIPPED propagation. The same library runs in-process in the local runner. |
| C7 | Build-events handler | Lambda on the EventBridge CodeBuild build-state rule | Updates job state in C9, sends the task token so C5 wakes instantly on any completion. Decider reconciles via `BatchGetBuilds` as belt-and-braces. |
| C8 | **Reporter** | Lambda on C9 DynamoDB Streams + the 1-min sweep | Reconciles check-run desired state to GitHub (§13.2). Stream path is the happy path; unconverged items fall to the sweep. |
| C9 | **State table** | DynamoDB, single-table, on-demand, TTL 90 d | The CLI's source of truth: runs, jobs, steps, counters, event dedupe, concurrency groups, check desired-state, per-ref registry. Schema in §9.1. |
| C10 | Polling table | DynamoDB, on-demand | Per-repo ref state (last-seen ref→sha map), PR ETags, quorum circuit-breaker item, per-repo quarantine markers. Kept separate from C9. |
| C11 | CodeBuild project | One project; everything per-run via `StartBuild` overrides | Runs synth jobs and user jobs. ARM on-demand EC2 default (`arm1.small`), x86 opt-in; Lambda compute mode is the synth escape hatch. Built-in `QUEUED` phase is the only queue. 36 h max duration. |
| C12 | Artifact/cache bucket | S3 | Run-scoped artifacts, keyed dependency caches, per-run source package + job model. Layout in §9.3. Lifecycle rules per `retention` prop. |
| C13 | Assets | S3 (CDK assets) | The static step-shim binary (§11.2), injected into builds as a secondary source. |
| C14 | CMK | KMS customer-managed key | Encrypts every SecureString in the SSM plane: workflow secrets, deploy keys, App PEM. The design's one standing cost. |
| C15 | Config plane | SSM Parameter Store under `/millwright/<name>/…` | Deployment manifest, per-repo config, credentials, host-key pins, workflow secrets. Paths in §9.2. |
| C16 | Sweep | Lambda on the 1-min scheduler | Reconciliation: unconverged checks (§13.2), concurrency-group crash safety (§8.4), per-run IAM role cleanup (§10.4). |
| C17 | Log groups | CloudWatch Logs | Per-build streams; retention 30 d default (`retention` prop). CLI deep-links; never the UX. |
| C18 | GitHub App | External, per deployment | REST-only work: check runs, tier-2 PR polling, deploy-key installation. Created via the manifest flow by `millwright setup`. Permissions: Contents: read, Checks: write, Commit statuses: write, Administration: write (deploy-key install). |

---

## 3. Packaging, versioning, configuration

### 3.1 Packages

Three npm packages under the existing **`@copperbox`** scope, released in lockstep with
one version:

| Package | Contents | Installed where |
|---|---|---|
| `@copperbox/millwright-workflows` | Tiny definition library (`WorkflowSet`, `Workflow`, `Trigger`, `Secret`, `Artifact`, `Cache`, `Compute`, `Step`, `hashFiles`). **No `aws-cdk-lib` dependency.** | The only install in watched repos. |
| `@copperbox/millwright-cdk` | The `Millwright` construct + bundled control-plane assets (Lambda code, shim binary, state machine). | The operator's CDK app. |
| `@copperbox/millwright-cli` | `bin: millwright`; npx-able. | Operator + developer machines. |

**Compatibility contract**: the run model carries a `schemaVersion`. The control plane
accepts schema **≤ its own**; synth fails loud otherwise. This governs skew between a
repo's workflows lib and the deployed control plane.

### 3.2 Deployment shape

**Construct library + thin generated app.** `millwright init` scaffolds a minimal
two-file CDK app instantiating `new Millwright(stack, {...})` for teams without a CDK
app; CDK-native teams compose the construct into their own app. Upgrades are npm version
bumps + `cdk deploy` — never a git merge of a cloned template.

**Construct props are pure infra knobs** — nothing security- or repo-shaped:

```ts
new Millwright(stack, 'Millwright', {
  deploymentName: 'millwright',      // default; namespaces SSM + resources
  permissionsBoundary: boundaryArn,  // applied to every synthesized job role
  pollCadence: Duration.minutes(1),  // default 1 min
  retention: { logs: Duration.days(30), metadata: Duration.days(90) },
});
```

Notification targets are deliberately absent (notifications are deferred).

### 3.3 Config split

**Security/cost config is operator-IAM-gated, not deploy-gated.** The guardrail
requirement is "not editable from a watched repo's branch"; a CLI writing SSM under
operator AWS credentials satisfies it. Hence:

- **Repos are dynamic, not construct props.** `millwright repo add` (§15) writes the
  repo's config param and generates its deploy key — no `cdk deploy` to add a repo.
- The poller reads repo config from the SSM plane by path prefix. DynamoDB stays purely
  run state.

### 3.4 CLI discovery and auth

**AWS credentials are the CLI's only auth** (profile / SSO / env — no millwright
tokens). The construct self-registers a manifest param at `/millwright/<name>/manifest`
(state table, log group, buckets, bus, state machine ARN). The CLI lists `/millwright/*`
and auto-picks when the account+region has exactly one deployment; otherwise requires
`MILLWRIGHT_DEPLOYMENT` / `--deployment`. No committed pointer file in watched repos.

---

## 4. Workflow definition API

Definitions live **in the watched repo** at `millwright/workflows.ts`. The control plane
synthesizes **the definition at the triggering commit**, so workflow changes are
branch/PR-testable. Reference sketch: `prototypes/workflow-api/workflows.ts`.

### 4.1 Construct model

`WorkflowSet` → `Workflow` (owns triggers) → `job(name, props)`.

```ts
const app = new WorkflowSet();
const ci = new Workflow(app, 'ci', {
  on: [Trigger.push({ branches: ['main'] }), Trigger.pullRequest()],
});
const build = ci.job('build', {
  image: 'public.ecr.aws/docker/library/node:22',
  compute: Compute.ARM_SMALL,
  cache: Cache.keyed({ key: hashFiles('package-lock.json'),
                       paths: ['node_modules'], restoreKeys: ['npm-'] }),
  steps: ['npm ci', 'npm test', 'npm run build'],
  produces: { dist: Artifact.dir('dist') },
});
ci.job('integration', {
  image: 'public.ecr.aws/docker/library/node:22',
  consumes: { dist: build.artifacts.dist },   // the DAG edge
  steps: ['npm run test:integration -- --dist dist/'],
});
export default app;
```

This is **not** CDK/CloudFormation: `millwright synth` emits millwright's own
declarative run model (§5); the control plane materializes bounded per-job IAM roles and
`StartBuild` calls from it. The CDK app is only millwright's own deployment.

### 4.2 Semantics

- **DAG from artifacts**: `consumes: build.artifacts.dist` is the dependency edge,
  synth-checked (every `consumes` must match a `produces` — fail at synth, not at 3am).
  Explicit `dependsOn` exists for artifact-less ordering. No `needs:` strings.
- **Triggers**: `Trigger.push({branches})`, `Trigger.tag({pattern})`,
  `Trigger.pullRequest()`, `Trigger.cron(expr)`, `Trigger.manual({inputs})`.
- **Manual dispatch always carries a ref** (default: default-branch head); definition
  and source are both pinned at that ref — `millwright dispatch release --ref v1.4.2`
  deploys v1.4.2 with v1.4.2's own workflow. Manual **inputs are typed**
  (choices/booleans), flowing into `steps: (inputs) => [...]`.
- **Steps** are plain shell strings; `Step.run(cmd, opts)` is the upgrade path.
  `Step.run(cmd, { skipIf: '<command>' })`: exit-0 guard compiles to shell that reports
  **SKIPPED** (`reason: skip_if`) to the run view and continues the job.
- **Matrices = loops** — each job is an independent `StartBuild`, parallel unless an
  edge says otherwise. No matrix DSL.
- **Sharing = npm packages**: platform repos export workflow functions/constructs. No
  reusable-workflow machinery.
- **Secrets** are declared per job (§11.3 injection, §10 IAM):
  `secrets: { NPM_TOKEN: Secret.named('npm-token'), X: Secret.fromSecretsManager(arn) }`.
- **Concurrency** is declared per workflow (§8.4):
  `concurrency: { group: 'deploy-${repo}', policy: 'queue' | 'supersede' }`.
- **`image` is required** — no default; resolved job > `Workflow` > `WorkflowSet`
  cascade; synth fails with a clear error when a job resolves to nothing (§11.1).
- **`compute`**: `Compute.*` sizing enum, ARM small default, x86 opt-in. `timeout`
  per job; CodeBuild enforces the hard per-build timeout, decider interprets policy.
- **`privileged: true`** enables docker-in-docker; the image must contain docker (§11.1).

### 4.3 Synth-time guardrails and lints

- Branch/PR runs receive **no secrets unless the ref matches the repo's declared
  allowlist** (`secretsAllowedRefs`, set via `repo add/update` — operator-gated, §3.3).
- All synthesized job roles sit under the **deployment-level IAM permissions boundary**.
- Lint: **secret masking is exact-match-only** — warn that transformed secret values
  leak into logs.
- Lint: **implicit Docker Hub reference** (bare `node:22`) — warn, recommending the
  `public.ecr.aws/docker/library/...` mirror (Hub rate limits from CodeBuild's shared
  egress IPs are a live production hazard).
- Error: job resolves to no `image`; `consumes` without matching `produces`; job-name
  collisions (names are check-run contexts, §13.2); run-model `schemaVersion` newer
  than the control plane's.
- Synth makes **no registry or network calls**; image lints are string-level only.
  Arch mismatch (x86-only image on ARM compute) surfaces as docker's own runtime error.

---

## 5. Run model (synth output)

`millwright synth` emits one JSON document — the contract between definition, cloud
orchestration, and local runner. Cloud synth lands it at the run's S3 prefix
(`model.json`, §9.3); local synth holds it in process.

```jsonc
{
  "schemaVersion": 1,
  "repo": "acme/api",
  "commit": "<sha>",
  "workflows": [
    {
      "name": "ci",
      "triggers": [ { "kind": "push", "branches": ["main"] }, { "kind": "pullRequest" } ],
      "concurrency": { "group": "ci-${ref}", "policy": "queue" },   // optional
      "jobs": [
        {
          "name": "build",
          "image": "public.ecr.aws/docker/library/node:22",
          "compute": "ARM_SMALL",
          "privileged": false,
          "timeoutMinutes": 60,
          "steps": [ { "run": "npm ci" },
                     { "run": "npm publish", "skipIf": "npm view ..." } ],
          "secrets": { "NPM_TOKEN": { "kind": "ssm", "name": "npm-token" },
                       "X": { "kind": "secretsManager", "arn": "arn:..." } },
          "produces": { "dist": { "type": "dir", "path": "dist" } },
          "consumes": { },
          "dependsOn": [],
          "cache": { "key": "npm-<hash>", "paths": ["node_modules"],
                     "restoreKeys": ["npm-"] }
        }
      ]
    }
  ]
}
```

Per-job `secrets` + private-ECR image URIs are the **requested IAM** the control plane
materializes into the job role (§10). Every successful cloud synth also extracts the
`(triggers, concurrency)` map into the per-ref registry (§8.3).

---

## 6. Triggering: polling architecture

### 6.1 Tier 1 — git protocol over SSH (resilient core)

EventBridge Scheduler (1-min rate, jitter window) → the non-VPC poller Lambda, which
polls **every configured repo per tick**:

- **Transport: pure-JS `ssh2`** (no native addon), exec `git-upload-pack 'owner/repo'`
  with a **`GIT_PROTOCOL=version=2` channel env**, authenticated with the repo's
  **read-only deploy key**. Proven live (ticket 016): babeld honors the env from a
  non-OpenSSH client; the v2 `ls-refs` exchange with `peel`/`symrefs`/`ref-prefix`
  returns e.g. **67 B vs a 344 KB / 5,282-ref v0 advertisement (~5,100x)**; ~1 s
  connect+auth, ~250 ms round trip. Detect fallback by first pkt-line: without the env,
  babeld streams the protocol-v0 advertisement — fat but correct; parse it anyway.
  Annotated exchange reference: `research/ssh-ls-refs-spike.md` on the
  `research/ssh-ls-refs-spike` branch.
- **Deploy keys always** — the everyday path *is* the outage path; no credential
  failover machinery. The App token never touches tier 1.
- **Diffing**: last-seen ref→sha map per repo in the polling table; diffs become
  `push` / `branch` / `tag` events on the bus. Tier 1 cannot distinguish force-push
  from fast-forward or identify the pusher; actor/commit metadata is a lazy API fetch
  that degrades with GitHub. Plan ref-map compression: DynamoDB's 400 KB item cap can
  bite at 1,000+ tags.
- **Host keys**: pinned from GitHub's `/meta` REST endpoint into SSM at setup;
  compiled-in published fingerprints as day-one defaults. On mismatch the poller
  re-fetches `/meta` over TLS and **auto-reconciles with an alarm** only if it confirms
  the new key, hard-failing otherwise. Manual escape hatch:
  `millwright refresh-host-keys`. (`ssh2`'s `hostVerifier` exposes the raw host-key
  blob for comparison.)
- **Key handling**: poller batch-fetches deploy keys via `GetParameters` on cold start
  and caches decrypted keys in memory while warm.

### 6.2 Tier 2 — PR polling (best-effort)

`GET /repos/{o}/{r}/pulls?state=all&sort=updated` with **per-repo ETags**, App-token
authenticated; authenticated 304s don't count against the primary rate limit, so steady
state is nearly free. 50 repos at 1-min polls worst-case ≈ 3,000 req/hr, inside the
5,000/hr App budget. Cadence band 60–120 s. Per-repo `prPolling` toggle in repo config.

### 6.3 Degradation

- **Quorum circuit breaker** (item in the polling table): SSH transport failures across
  ≥3 repos ⇒ open; canary probe with decaying interval. It guards transport only —
  the credential-lifecycle failure mode is gone with deploy keys.
- **Per-repo quarantine**: SSH "Repository not found" / key-auth rejection (GitHub
  deliberately conflates deleted vs access-revoked) ⇒ quarantine the repo, don't trip
  the breaker.
- Backoff with jitter on tier-2 API errors; tier 2 simply lags when the API is down.

**Latency floor**: ~30–90 s typical detection, ~2 min worst case. Sub-minute needs
self-rescheduling hacks and isn't worth it. Cost: ~$0.80–2.40/mo for 10–50 repos.

### 6.4 Cron and manual dispatch

- **Cron** (spec-filled, §18): the poller tick doubles as the cron clock — each tick it
  evaluates `Trigger.cron` entries from each repo's **default-branch registry entry**
  (§8.3) and emits `cron` events for expressions whose minute has arrived. Cron is
  inherently ref-less; it always runs the default branch.
- **Manual dispatch** (spec-filled, §18): `millwright dispatch` puts a `dispatch` event
  on the bus under the operator's AWS credentials, carrying workflow, ref (resolved to
  a sha), and typed inputs. It then flows the launcher path like every other event —
  uniform concurrency gating, no special lane.

---

## 7. Run orchestration

### 7.1 Run start

EventBridge rule → **launcher Lambda**:

1. **Dedupe** the event: conditional put on event id (EventBridge is at-least-once).
2. **Match** event → workflows via the per-ref registry (§8.3).
3. **Gate concurrency** (§8.4) — may create the run QUEUED, or supersede.
4. Atomically **increment the per-workflow run counter** → workflow-scoped run number
   (`ci#142`).
5. Write the run record (PENDING), call `StartExecution` on the run executor.

### 7.2 Synth job

The state machine's first step is a **synth job on CodeBuild** at the triggering commit:
clone via deploy key, `npm ci`, run `millwright synth`; land `model.json` and the
packaged source archive at the run's S3 prefix; write the ref's registry entry (§8.3).
*Escape hatch (pre-approved tuning knob)*: synth needs no docker — it can move to
CodeBuild **Lambda compute mode** if latency ever warrants; measured provisioning
(2–7 s, §16) means it currently doesn't.

### 7.3 Decider loop

**Dispatch-on-completion** (wave-based Map+`.sync` was rejected for its level-barrier
scheduling wart). One generic, deployed-once Step Functions Standard machine loops the
**decider Lambda**:

- Read job model + job states from DynamoDB → fire-and-forget `StartBuild` for every
  job whose deps just completed → wait on `waitForTaskToken` (~30 s heartbeat).
- The build-events handler updates DynamoDB on CodeBuild state changes and sends the
  token — the loop wakes instantly on any completion; the decider reconciles via
  `BatchGetBuilds` as belt-and-braces.
- **Per-job retries and timeout policy live in the decider's TypeScript**; CodeBuild
  enforces the hard per-build timeout.
- The decider is a pure library (`decide(jobModel, states, cancelRequested) → actions`)
  **reused in-process by the local runner** (§14).

### 7.4 Per-job dispatch

One `StartBuild` per job on the single CodeBuild project, with per-run overrides:
image, compute type, privileged mode, env, timeout, service role (the job's
materialized role, §10), inline buildspec (generated: prelude → source/artifact
restore → cache restore → shim-wrapped steps → artifact/cache save, §11).
CodeBuild's built-in `QUEUED` phase (+ `queuedTimeoutInMinutes`) is the only queue.

### 7.5 Status algebra

- Job states: PENDING → QUEUED/PROVISIONING → RUNNING → SUCCEEDED | FAILED |
  TIMED_OUT | CANCELLED | SKIPPED.
- **Transitive dependents of a failed job → SKIPPED with `reason: upstream_failed`**
  (distinct from `reason: skip_if`); independent branches run to completion.
- Run status: FAILED if any job FAILED/TIMED_OUT; CANCELLED if cancelled (including
  `reason: superseded`, §8.4); SUCCEEDED iff every job SUCCEEDED or was SKIPPED via
  guard. **No fail-fast in v1** (deferred); **no soft-fail/allow-failure** (out of
  scope).

### 7.6 Cancellation

**Cancellation is decider input, not an outside kill.** The CLI writes
`cancelRequested` on the run record and sends the task token; the decider `StopBuild`s
in-flight builds, marks every non-terminal job CANCELLED, marks the run CANCELLED, and
exits the loop cleanly. `StopExecution` is documented break-glass only. Local Ctrl-C
sets the same flag through the same path.

### 7.7 Rerun

`millwright runs rerun <run>` creates a **new run** (fresh number, `rerunOf` metadata)
from the **stored job model** — no re-synth; reruns skip the synth job and start
faster. `--failed` reruns FAILED/TIMED_OUT/CANCELLED jobs plus their SKIPPED
dependents: the launcher **prefix-copies** succeeded jobs' artifacts into the new run's
S3 prefix (per-run IAM intact) and the decider seeds those jobs terminal SUCCEEDED with
`reusedFrom`. Nothing failed → `--failed` rejects with "nothing to rerun". Reruns gate
through concurrency groups like any other run.

### 7.8 Step-level status

The **in-build step shim writes DynamoDB directly** (post-hoc log parsing rejected:
brittle, no live visibility). Each generated buildspec wraps steps in the shim, which
records start/end/status/skip-reason. Writers are partitioned, never overlapping:
**launcher** (counter, run create, dedupe, group claims), **decider** (run + job rows,
group hand-off), **shim** (own step rows only, confined by IAM `dynamodb:LeadingKeys`),
**CLI** (`cancelRequested` only).

---

## 8. Concurrency

### 8.1 Primitive

**Opt-in concurrency groups; membership means at most one run executes at a time.**
No group declared → unlimited concurrent runs. No numeric limits in v1 (the group item
can carry a count later without reshaping the API).

### 8.2 Keys, policies, queueing

- **Group keys**: static strings + a closed set of trigger-context tokens —
  `${ref}`, `${workflow}`, `${repo}`, `${event}` — all evaluable by the launcher
  pre-synth; nothing model-derived. Scope is **deployment-global** (a repo-spanning
  `deploy-prod` lock is free); include `${repo}` for repo-local behavior — docs
  convention, candidate lint.
- **Policies** (per group): **`queue`** (default) — the new run waits, loss-free for
  deploy-style groups; **`supersede`** (opt-in) — the new run cancels the in-flight run
  via the standard `cancelRequested` path.
- **Pending slot of one** (GHA-style): a group holds at most one waiting run; a newer
  arrival replaces it. Replaced-pending and superseded-in-flight runs are **CANCELLED
  with `reason: superseded`** — the status algebra stays closed; the CLI renders the
  reason. Superseded runs are rerunnable.
- **Uniform gating**: poll, cron, dispatch, and rerun all gate identically at the
  launcher; **no bypass flag**. Break-glass is explicit: cancel the in-flight run.
- **Local runs don't enforce** concurrency (zero-AWS-calls property; groups belong to
  the deployment's orchestration).
- **CodeBuild account quota: surface, don't manage.** `millwright doctor` reports the
  account's concurrent-build quotas against the deployment's plausible fan-out and
  points at the increase request. Beyond-quota builds queue at AWS (measured 30–40 s
  bursts), they don't fail. No millwright-side throttle.

### 8.3 The per-ref registry (pre-synth config visibility)

The launcher must match events → workflows and gate concurrency **before** the run's
synth job exists, yet the definition lives at the triggering commit. Mechanism:
**every successful synth writes the repo's trigger + concurrency map to DynamoDB keyed
by ref**. The launcher matches an event against its ref's entry, **falling back to the
default branch's map** for never-synthed refs. Consequences: branch config changes take
effect from that branch's second run; a new branch's first push uses default-branch
config. This registry is also how the launcher knows which workflows an event triggers
at all.

### 8.4 Mechanics

A `GROUP#<key>` item in the state table holds the running and pending run ids. The
launcher claims or replaces the pending slot with conditional/transactional writes
(run records for queued runs are created at queue time, marked QUEUED). On run
completion the decider clears the running slot and starts the pending run's execution.
The reconciliation sweep (C16) is crash-safety: it detects groups whose running run is
terminal but whose slot never cleared, and starts the pending run.

---

## 9. Data stores and schemas

### 9.1 State table (DynamoDB, single-table, on-demand)

TTL 90 days on all items (`retention.metadata`; logs' 30 days is CloudWatch retention
config, separate). Item names marked ◊ are spec-level naming (§18), not ticket text.

| Item | PK | SK | Notes |
|---|---|---|---|
| Run counter | `WF#<repo>#<workflow>` | `COUNTER` | Atomic increment by launcher. |
| Run | `WF#<repo>#<workflow>` | `RUN#<inverted zero-padded number>` | Status, trigger kind, ref, sha, timestamps, `cancelRequested`, `rerunOf`, `reason`. Inverted number ⇒ `runs list` is one Query, most-recent-first; ref/status filters are FilterExpressions (GSI only if a filter gets hot — not v1 structure). |
| Job | `RUN#<repo>#<workflow>#<number>` | `JOB#<name>` | Status, build id/ARN, log stream, timings, `reusedFrom`, skip reason. One Query per partition serves `runs show`. |
| Step | `RUN#<repo>#<workflow>#<number>` | `JOB#<name>#STEP#<index>` | Written by the in-build shim: start/end/status/skip-reason/exit code. |
| Event dedupe | `EVENT#<event-id>` | `-` | Conditional put; short TTL. |
| Concurrency group | `GROUP#<key>` | `-` ◊ | `running` run id, `pending` run id; conditional/transactional writes (§8.4). |
| Registry | `REG#<repo>` ◊ | `REF#<ref>` ◊ | Per-ref trigger + concurrency map written by every successful synth (§8.3); `schemaVersion`, per-workflow `{triggers, concurrency}`. |
| Check state | `CHECK#<repo>#<sha>` ◊ | `CTX#<context>` ◊ | `desired`, `reported`, `check_run_id`, backoff state, abandoned flag (§13.2). |

### 9.2 SSM config plane (`/millwright/<name>/…`)

All SecureStrings encrypted with the dedicated CMK (C14). Two-gate posture everywhere:
reads need `ssm:GetParameter` **and** `kms:Decrypt`.

| Path | Type | Contents |
|---|---|---|
| `/millwright/<name>/manifest` | String | Deployment manifest: state table, log group, buckets, bus, state machine ARN. Written by the construct; the CLI's discovery root. |
| `/millwright/<name>/repos/<repo>/config` | String (JSON) | `secretsAllowedRefs`, `prPolling`. Written by `repo add/update` under operator IAM. |
| `/millwright/<name>/repos/<repo>/deploy-key` ◊ | SecureString | Ed25519 private key (~400 B, fits the 4 KB standard tier; standard tier is free — Secrets Manager at $0.40/secret/mo would 10x the polling stack at 50 repos). |
| `/millwright/<name>/github/app` ◊ | SecureString | App id + private key PEM + webhook-less secrets from the manifest exchange. |
| `/millwright/<name>/github/host-keys` ◊ | String | Pinned SSH host keys, seeded from `/meta`. |
| `/millwright/<name>/secrets/<scope>/<NAME>` | SecureString | Workflow secrets, authored by `millwright secrets set`. *(Path amended under the deployment prefix — §17.)* |

Existing **Secrets Manager ARNs are accepted as passthrough references** in workflow
definitions, so teams don't copy values out. Millwright itself stores nothing in
Secrets Manager (§17).

### 9.3 S3 layout (artifact/cache bucket)

Prefix names marked ◊ are spec-level naming (§18).

```
runs/<repo>/<workflow>/<number>/            ◊ the "run prefix" — per-run IAM boundary
    model.json                              ◊ synth output (§5)
    source.tar.gz                           ◊ packaged source at the triggering commit
    <job>/<artifact-name>/…                   declared artifacts (009 layout)
cache/<repo>/<key>                          ◊ keyed dependency-cache objects
```

- Jobs never clone; they pull `source.tar.gz` from the run prefix (§11.2).
- Rerun `--failed` prefix-copies succeeded jobs' `<job>/…` subtrees into the new run's
  prefix.
- Retention via lifecycle rules (`retention.metadata` for runs/, cold-entry eviction
  for cache/). CodeBuild's native artifacts and S3 cache modes are **unused** — one
  unkeyed cache per project invites branch poisoning and silent staleness.

### 9.4 Polling table

Per-repo items: last-seen ref→sha map (compressed if large), tier-2 ETags, quarantine
marker; one circuit-breaker item. Never queried by the CLI.

---

## 10. IAM model

### 10.1 Boundary

Every role millwright synthesizes for user jobs sits under the deployment-level
**permissions boundary** (`permissionsBoundary` construct prop). The boundary caps what
any workflow definition can request — definitions are repo-editable, so the boundary is
the operator's hard ceiling.

### 10.2 Per-job roles

The control plane materializes a **least-privilege role per job per run** from the run
model's requested IAM:

- Declared secrets → `ssm:GetParameter` on exactly those parameters +
  `kms:Decrypt` on the CMK (or `secretsmanager:GetSecretValue` on passthrough ARNs).
  Undeclared secrets are unreadable; a compromised build script can only exfiltrate
  what its job declared.
- Artifacts → S3 get/put confined to **its own run's prefix** (`runs/<repo>/<wf>/<n>/*`),
  plus get on `cache/<repo>/*` and put on the job's cache key.
- Step-status writes → DynamoDB put/update with a **`dynamodb:LeadingKeys` condition**
  confining the shim to its own run's items.
- Private-ECR image URI → **auto-granted pull permissions** on that image (synth
  detects the URI shape).
- Secrets gating: branch/PR runs whose ref misses `secretsAllowedRefs` get roles with
  **no secret grants at all** (§4.3).

### 10.3 Control-plane roles

Poller: read deploy keys/host-key pins (GetParameters), polling table, PutEvents.
Launcher: state table writes, StartExecution. Decider: state table, StartBuild/StopBuild,
BatchGetBuilds, role materialization (§10.4), artifact prefix-copy. Shim role: none of
its own — the job role carries the LeadingKeys grant. Reporter: state table + stream,
GitHub App token minting (reads App PEM). All control-plane roles are fixed at deploy
time; only job roles are dynamic.

### 10.4 Job-role lifecycle (spec-filled — flagged, §18)

Per-run grants (run prefix, LeadingKeys) make job roles inherently per-run, and IAM's
default 1,000-role quota makes unbounded creation a real operational risk at
~500 roles/day. The tickets did not decide a lifecycle; this spec fills it:

- The **decider materializes each job's role idempotently** before first dispatch
  (deterministic name ◊ `mw-<name>-<repo>-<wf>-<number>-<job>`, truncated/hashed to
  IAM's 64-char limit), boundary-attached, tagged with the run id.
- The **sweep (C16) deletes roles** for runs that reached a terminal state more than
  24 h earlier ◊.
- `millwright doctor` reports IAM role count against quota alongside the CodeBuild
  concurrency check.

This is the one gap large enough to call out: the *decisions* (per-job least-privilege,
run-prefix grants, LeadingKeys) are all ticket-locked; the *lifecycle mechanics* above
are spec-authored and should get a design review during build.

---

## 11. Job execution environment

### 11.1 Image model

- **Contract: Linux + POSIX shell, nothing more.** Images are never millwright-aware;
  git and node are **not** required in job images.
- **`image` is required, no default**, job > `Workflow` > `WorkflowSet` cascade (§4.2).
  Millwright can't know a team's toolchain; any default is wrong for most jobs.
- **Millwright publishes no images** — not at deploy time, not as an OSS artifact
  (CVE/version/multi-arch treadmill). Escape valve if dind pressure appears:
  documented Dockerfile recipes, never a published image.
- **Image is the toolchain**: no runtime/setup DSL. Version pinning = image-tag
  pinning; matrices interpolate tags; heavier needs = small custom image in the team's
  own ECR (cloud pulls via synthesized IAM; local via the user's own `docker login`).
- `image` is a **plain string** with docker-run semantics. Lints are string-level only
  (§4.3).
- **Privileged jobs: documented contract that the image contains docker** (CLI +
  daemon); blessed zero-effort choice:
  `public.ecr.aws/docker/library/docker:<ver>-dind`. Synth can't verify (no registry
  calls) — contract, not lint.

### 11.2 Generated buildspec: prelude, shim, steps

Every job's inline buildspec follows one shape:

1. **Prelude**: if `privileged: true` and no docker socket is already live,
   **auto-start `dockerd`** and wait for the socket (the socket-liveness guard makes
   the same prelude a no-op locally, where the host socket is mounted).
2. **Source**: unpack `source.tar.gz` from the run prefix.
3. **Shim delivery**: the static shim binary arrives as an **S3 secondary source**
   (the CodeBuild agent materializes sources regardless of image contents); local runs
   bind-mount it.
4. **Cache restore**: exact-key hit, else `restoreKeys` prefix fallback.
5. **Steps**, each wrapped by the shim (records start/end/status/skip to DynamoDB;
   evaluates `skipIf` guards → SKIPPED).
6. **Artifact upload** (`produces`) to the run prefix; **cache save** (skipped on
   exact-key hit).
7. Secrets arrive before step 1 via CodeBuild-native `env.parameter-store` /
   `env.secrets-manager` blocks — env vars with exact-match log masking for free
   (§4.3's lint covers the masking limitation). File-shaped secrets are v1'd by a job
   step writing the env var to disk.

### 11.3 Compute

ARM `arm1.*` on-demand EC2, `ARM_SMALL` default; x86 opt-in via `Compute.*`. Reserved
capacity is rejected (violates zero-idle; ~$89/mo/instance exceeds the whole on-demand
bill). Measured floor (ticket 012, full matrix, 24 builds): **PROVISIONING 2–7 s**
everywhere — standard image non-privileged ~3 s; privileged +3–4 s; custom public-ECR
image +2–3 s; effects don't stack beyond ~6 s; size makes no difference.

---

## 12. Artifacts and caching

- **Artifacts**: declared `produces`/`consumes` (§4.2) — synth-checked, doubles as the
  DAG. Stored under the run prefix with per-run IAM (§10.2). Retention via lifecycle
  rules.
- **Dependency caches**: GHA-style keyed semantics — `hashFiles` keys, `paths`,
  `restoreKeys` prefix fallback; exact hit skips save; lifecycle eviction for cold
  entries. Millwright-keyed S3 objects; CodeBuild native cache unused.
- **Docker layer caching**: outside the keyed system in v1. Local layer cache is
  opportunistic-only on ephemeral hosts; buildx with an ECR/S3 backend is a job-level
  technique users apply in their own steps. A `DockerCache` construct is deferred.

---

## 13. GitHub integration

### 13.1 Auth

**Hybrid, with deploy keys as a universal invariant:**

- **Per-repo read-only Ed25519 deploy keys** carry *all* git-protocol work — tier-1
  polling and job source cloning — because they never touch the REST API and keep
  working through API outages. Generated by `repo add`, stored in SSM under the CMK,
  installed via the App's Administration permission (or printed for manual add).
- **Per-deployment GitHub App** carries REST-only work: check runs, tier-2 PR polling.
  Created via the **manifest flow** (`POST /app-manifests/{code}/conversions` returns
  app id + PEM in one exchange) by `millwright setup` — nearly turnkey single-tenant
  App creation. Rate limit ≥5,000 req/hr per installation, scaling with repo count,
  cap 12,500. Installation tokens are minted on demand and **cached in memory/DynamoDB,
  never stored as rotated secrets**.
- **Fine-grained PAT fallback** (`setup --pat`) for small setups: commit statuses
  instead of check runs (Checks API is App-only); 5,000/hr shared across the user's
  tokens. A PAT with repo Administration:write keeps deploy-key onboarding automated.
  App-vs-PAT is a pure REST-surface choice; the tier-1 path is identical in all modes.

### 13.2 Check reporting

**Check runs, reconciled from DynamoDB desired state, posted per-commit
unconditionally.**

- **Granularity**: one check per job, named **`<workflow> / <job>`** (job names
  synth-validated ⇒ stable contexts for required-check gating). No run-level rollup in
  v1. PAT mode degrades to commit statuses with the **same context names**, so branch
  protection works identically.
- **Lifecycle**: run start creates a single **`millwright / synth`** check
  (`in_progress`) — the job list doesn't exist pre-synth. Synth success completes it
  and batch-creates per-job checks as `queued`; jobs go `in_progress` on dispatch and
  complete `success`/`failure`/`cancelled`/`skipped`. Synth failure fails the synth
  check with the error in its summary — a broken `workflows.ts` is always visible on
  the PR. Docs recommend requiring `millwright / synth` in branch protection.
- **Architecture — desired-state reconciliation, not an event queue**: the decider
  upserts a check item per (sha, context) with `desired`/`reported`/`check_run_id`;
  the reporter fires off **DynamoDB Streams** for the happy path, with unconverged
  items falling to the 1-min sweep. The reporter always posts the *latest* desired
  state — outage replay coalesces to one call per check; out-of-order updates are
  structurally impossible.
- **Degradation**: per-item exponential backoff (1 m → 15 m cap) honoring
  `Retry-After`; unconverged after **7 days** → abandoned (visible in `runs show`);
  90 d TTL clears it. Duplicate creates from crash windows are benign (latest-wins per
  name/sha). A late flush is still true for its sha and can never bless a newer commit.
- **Scope**: every cloud run reports to its commit sha, PR or not — checks attach to
  shas, so PR reporting **never depends on tier-2 PR polling**. Local runs never
  report. Budget ≈ 1,500 calls/day vs 5,000/hr.
- **Content**: job-check markdown carries run number, per-step conclusions/durations,
  the failed step with last log lines, and the triage command
  (`millwright logs ci#142 --failed`); details URL deep-links to the job's CloudWatch
  stream. PAT mode: ~140-char status description + URL.
- **V1 omissions**: no file/line annotations; no check-run re-run button (requested
  actions are webhook-delivered only — rerun stays in the CLI).

---

## 14. Local execution

**`millwright run <wf>` is always local; `millwright dispatch <wf>` is always cloud** —
the verb split makes running in the wrong place impossible. Reference session:
`prototypes/local-runner/SESSION.md`.

Shared core, two thin hosts: the pure decider library + step shim run in-process
against two seams — **`Executor`** (`StartBuild` ↔ `docker run`) and **`StateSink`**
(DynamoDB ↔ `.millwright/runs/local-N.json`). Same DAG logic, SKIPPED semantics,
terminal states; Ctrl-C sets the same `cancelRequested` flag through the same path.

The parity contract:

| | Cloud run | Local run | Parity |
|---|---|---|---|
| Definition + synth | synth at triggering commit (CodeBuild, `npm ci`) | same code, in-process bundle (sub-second; node_modules fidelity gap accepted) | **same model** |
| Job order / retries / skips | decider Lambda | same decider, in-process | **same code** |
| Step status + SKIPPED | shim → DynamoDB | same shim → local state file | **same code** |
| Job environment | CodeBuild + declared image | local docker, same image (host-native arch; `--platform` for exact) | **same image** |
| Image pull/auth | CodeBuild role / synthesized ECR grants | user's own docker config — millwright does no registry auth | delegated |
| Source | clean checkout at commit | git-aware **working-tree copy** per job (no bind mount); `--clean` = `git archive HEAD` | ≈, explicit |
| Secrets | SSM/SM → env vars | gitignored `.millwright/secrets.env` (or `--secrets-file`) → env vars; missing declared secrets fail before any job starts | same contract |
| Artifacts | S3 run prefix | `.millwright/runs/<id>/<job>/<name>` | same layout |
| Dependency cache | S3 keyed | local dir, same keys | same semantics |
| IAM / AWS calls | per-job least privilege | **zero AWS calls** | absent, by design |
| Compute sizing | honored | ignored (noted); `timeout` enforced | advisory |
| Run identity | `ci#142`, in `runs list` | `local-N` per clone under gitignored `.millwright/`, never in `runs list` | separate namespaces |

Inner loop: `--job X` runs one job, satisfying `consumes` from the most recent local
run's artifacts (reuse printed with age; error names the producing job if absent);
`--with-deps` runs the ancestor subgraph. Trigger predicates are never evaluated
locally; `MILLWRIGHT_*` context vars are synthesized from the checkout (dirty tree →
`-dirty` sha), with overrides like `--as-tag v9.9.9-test`. Typed inputs prompt
interactively or come from `--input k=v`. Privileged jobs mount the host docker socket
with a one-line fidelity warning. Concurrency config is carried but not enforced.

---

## 15. CLI command surface

Flags shown are the v1 contract; `--deployment` / `MILLWRIGHT_DEPLOYMENT` applies
everywhere (§3.4). Exit codes are scriptable: `logs -f` mirrors the run result.

```
Setup & ops
  millwright init                          scaffold the thin CDK app
  millwright setup [--pat]                 GitHub App manifest handshake (browser) | PAT mode
  millwright repo add <owner/repo> [--secrets-refs <refs>] [--no-pr-polling]
                                           write repo config, mint+install deploy key
  millwright repo update <owner/repo> [--secrets-refs <refs>] [--pr-polling <bool>]
  millwright repo list | repo remove <owner/repo>        ◊ (spec-filled, §18)
  millwright doctor                        verify chain: SSM manifest, App creds, deploy
                                           keys, poller ticking; report CodeBuild
                                           concurrency + IAM role quotas
  millwright refresh-host-keys             re-pin GitHub SSH host keys from /meta
  millwright secrets set <name> [--scope <scope>]        author a workflow secret

Definition
  millwright synth                         compile workflows.ts, print model/lint results

Execution
  millwright run <wf> [--job X [--with-deps]] [--clean] [--platform <p>]
                 [--secrets-file <path>] [--input k=v ...] [--as-tag <tag>]
                 [--parallel N]            always local
  millwright dispatch <wf> [--ref <ref>] [--input k=v ...]   always cloud

Observability
  millwright logs [-f] [<run>] [--job <name>] [--failed] [--full]
                                           no-arg -f waits for the next run to appear
                                           (push-and-watch: git push && millwright logs -f)
  millwright runs list [--workflow <wf>] [--ref <ref>] [--status <s>]   ~20/page
  millwright runs show [<run>]             DAG + per-job/per-step status, culprit inline
  millwright runs rerun <run> [--failed]
  millwright runs cancel <run>
```

- **Run identity**: workflow-scoped run numbers (`ci#142`); an internal unique id
  exists but is never required typing. Latest-run defaults: `logs -f` and `runs show`
  with no run argument resolve to the most recent run (scoped by `--workflow`).
- **No web UI in v1.** GitHub check runs are team-glance visibility; the CLI needs no
  auth story beyond AWS credentials and keeps working during GitHub outages. Raw
  CloudWatch stays an escape hatch via deep links, never the UX.
- `logs -f` implementation: **polled `GetLogEvents` (~2 s), not CloudWatch Live Tail**
  ($0.01/min sessions and session limits buy latency CI logs don't need); run-level
  interleaved tail, docker-compose style, job-name prefixes + lifecycle markers.
- Retention: run metadata 90 d, logs 30 d (deployment knobs). No log archival.

**Setup flow** (discrete guided commands, no wizard):
`init` → plain `cdk deploy` (never wrapped — the operator owns the infra artifact) →
`setup` → `repo add` per repo → `doctor`.

---

## 16. Latency and cost expectations

| | Figure | Source |
|---|---|---|
| Push → detection | ~30–90 s typical, ~2 min worst | ticket 002 |
| CodeBuild PROVISIONING | 2–7 s across the whole v1 matrix | ticket 012, measured |
| Push → first log line | **"typically under two minutes"** — promise without hedging | ticket 012 |
| Polling stack | ~$0.80–2.40/mo at 10–50 repos | ticket 002 |
| CMK | ~$1/mo (the one standing cost) | ticket 008 |
| Compute at 100 runs/day × 5 min | ~$51/mo on arm1.small ($10–$204 across 50×2 min → 200×10 min) | ticket 001 |
| Per-build minute rounding | +5–15% at typical job lengths | ticket 001 |
| Concurrent-start bursts | intermittent 30–40 s QUEUED on fresh accounts; queue, don't fail | ticket 012 |

---

## 17. Amendments log — contradictions resolved (later decision wins)

1. **Tier-1 polling transport/credential**: 002 designed HTTPS + App installation
   token → **011: SSH + deploy keys, always** (App tokens die ≤1 h into an API
   outage). 016 proved the SSH path live. The pkt-line/`ls-refs` parser carries over.
2. **System-credential storage**: 003 put App PEM + deploy keys in Secrets Manager →
   **011: SSM SecureString under the CMK** (SM would cost $0.40/secret/mo — 10x the
   polling stack at 50 repos; SSM standard tier is free and Ed25519 keys fit 4 KB).
3. **Deploy-key provisioning moment**: 011 said "at setup" → **014: at
   `millwright repo add`** (repos are dynamic, not deploy-time).
4. **Workflow-secret SSM path**: 008 decided `/millwright/secrets/<scope>/<NAME>` →
   folded under 014's deployment prefix as
   `/millwright/<name>/secrets/<scope>/<NAME>` for one coherent config plane. (Small;
   noted because it changes a decided literal path.)
5. **Launcher trigger-matching**: 004/006 never recorded how the launcher matches
   events → workflows pre-synth → **015: the synth-written per-ref registry** (§8.3),
   which also carries concurrency config.
6. **CodeBuild native S3 cache**: 001 suggested designing around it → **009: unused**
   (unkeyed per-project cache invites branch poisoning).
7. **Durable check queue**: 003 radiated "durable queue that flushes on recovery" →
   **010 satisfies it structurally** with desired-state reconciliation instead of a
   literal queue — strictly better (coalescing, no out-of-order).

None of these rise above "small": each was explicitly reconciled by a later ticket or
is a naming-level fold. **No unresolved contradictions remain.**

## 18. Gaps filled by this spec (not ticket-decided — review during build)

Marked ◊ throughout. In descending order of substance:

1. **Per-run job-role lifecycle** (§10.4) — creation point (decider, idempotent),
   naming, and sweep-based deletion are spec-authored. The only fill that warrants a
   real design pass (IAM quota pressure is real at ~500 roles/day).
2. **Cron firing mechanism** (§6.4) — poller tick evaluates cron from the
   default-branch registry entry. Natural (the tick and the registry both exist), but
   no ticket said it.
3. **Manual-dispatch transport** (§6.4) — CLI `PutEvents` under operator credentials,
   flowing the uniform launcher path.
4. Item/key naming for GROUP/REG/CHECK rows, SSM credential paths, S3 prefix names,
   `source.tar.gz` packaging, `repo list`/`repo remove` — pure naming/completeness
   fills.

## 19. Deferred (fog) and out of scope

**Deferred — may graduate later**: fail-fast (cancellation path now exists); GHA YAML
importer; notifications & badges; run web UI; `SecretFile` construct; `DockerCache`
construct; opportunistic webhook fast-path (would carry check re-run buttons);
check-run annotations; concurrency extensions (numeric limits, full FIFO, `reject`,
dispatch bypass).

**Out of scope — returns only if the destination is redrawn**: multi-tenancy /
millwright-as-a-service; code hosting and PR/review UX; webhook-*dependent* triggering;
soft-fail / allow-failure jobs.
