# @copperbox/millwright-cdk

The `Millwright` CDK construct: deploys the millwright control plane into your
AWS account. Compose it into an existing CDK app, or let `millwright init`
scaffold the minimal two-file app for you.

```ts
import { Millwright } from '@copperbox/millwright-cdk';

new Millwright(stack, 'Millwright', {
  deploymentName: 'millwright',      // default; namespaces SSM + resources
  permissionsBoundary: boundaryArn,  // REQUIRED (Boundary.NONE to opt out, with a warning)
  pollCadence: Duration.minutes(1),  // default
  retention: { logs: Duration.days(30), metadata: Duration.days(90) },
});
```

`permissionsBoundary` is the one required prop: it is the only cap on the IAM
that repo-editable workflow definitions can request. The construct throws at
construct time without it, so the failure surfaces at `cdk synth`.

The construct self-registers a deployment manifest at
`/millwright/<deploymentName>/manifest`, which the CLI uses for zero-config
discovery.

## Event bus and launcher

The construct provisions the event bus (`<deploymentName>-bus`, recorded in
the manifest as `resources.eventBus`) and the launcher Lambda that turns bus
events into runs. The bus resource policy binds each `events:source` to its
one legitimate emitter, so several physical names are **pinned contracts**
that the components creating them must use exactly:

| Pinned name | Who must create it |
|---|---|
| `<deploymentName>-poller` (role) | the poller — sole emitter of `millwright.poller` events |
| `<deploymentName>-job-*` (roles) | per-run job roles — sole emitters of `millwright.step` events |
| `<deploymentName>-run-executor` (state machine) | the run executor — the launcher's grant and `RUN_EXECUTOR_ARN` already point at it |
| `<deploymentName>-builds` (CodeBuild project) | the build project (C11) — the decider dispatches onto it and the build-events rule filters on it |
| `<deploymentName>-synth` (Lambda) | the synth phase — invoked by the state machine with `{ taskToken, input }`; must complete the token when the synth build lands |
| `<deploymentName>-post-synth` (Lambda) | post-synth model validation, registry write, and synth-check reporting |

The launcher consumes events through an SQS queue; failed deliveries retry on
the visibility timeout, which is also how a first-push bootstrap replays once
its synth-only execution has written the per-ref registry.

## Run executor

The construct deploys the run executor (`<deploymentName>-run-executor`): one
generic Step Functions Standard machine executing one run — synth job,
post-synth validation/registry step, then the decider loop. The loop invokes
the decider Lambda (wrapping the pure `decide` library from
`@copperbox/millwright-state`) with a task token that the decider writes onto
the Run item; the wait carries a 60 s timeout whose catch re-enters the
decider, and no state uses heartbeats. The build-events handler, on the
default bus's CodeBuild build-state rule, updates job rows through `BUILD#`
mapping items and sends the token best-effort so the machine wakes on any
completion; with that rule disabled, runs still complete via the timeout
reconciliation path. Long runs carry over to a fresh execution of the same
machine before the Step Functions history ceiling, resuming from table state.

Still owned by later issues: check desired-state writes (§13.2) and job-role
variant selection at dispatch (§10.2). Dispatch renders every job's buildspec
through the shared control-plane renderer (§7.4) from
`@copperbox/millwright-state`.

## Concurrency groups and sweep (C16)

Workflows may declare `concurrency: { group, policy }` (spec §8.4); the
launcher evaluates the group key's `${ref}`/`${workflow}`/`${repo}`/`${event}`
tokens pre-synth, stamps it on the run record, and gates through the
`GROUP#<key>` item's running/pending slots with conditional writes — `queue`
waits in the pending slot of one, `supersede` additionally requests
cancellation of the in-flight run; a replaced waiter is CANCELLED with
`reason: superseded` and stays rerunnable. On run completion the decider
releases the slot and starts the pending run — start first, promote second,
so every crash point converges. The **sweep**, a Lambda on the 1-minute
scheduler, is that crash safety: it finds groups whose running run is
terminal but whose slot never cleared and re-runs the same release. It
repairs group slots only — run-level caps guarantee dead executions don't
exist, so it never resurrects one.

## Step shim and step events (C13, C19)

Every step of every job runs wrapped by the **step shim**, delivered from the
artifact bucket's `control/shim/` prefix — attached to each build as its S3
secondary source, bind-mounted by the local runner. The delivered entry,
`millwright-shim`, is a POSIX-sh dispatcher (invoked through `sh`, since S3
materialization strips execute bits) that execs the static per-arch binary
beside it, so job images keep the "Linux + POSIX shell, nothing more"
contract. `npm run build:shim` builds those binaries (Node SEA, linux-x64 and
linux-arm64); without them the construct stages a node-on-PATH fallback
bundle and warns at synth.

The shim reports start/end/status per step and evaluates `skipIf` (guard exit
0 → a SKIPPED step with `reason: skip_if`, and the job continues). **It does
not write the table.** It emits step events via `events:PutEvents` under
`source: millwright.step` — the only source the bus policy accepts from job
roles, which have no DynamoDB access at all. The **step-events writer (C19)**,
on the bus rule for that source, projects the events into step rows,
idempotent on `(run, job, step-index)`; its role carries step-row
`dynamodb:UpdateItem` and nothing else. Locally the same shim appends the
same payloads to the file named by `MILLWRIGHT_STEP_EVENTS_FILE` instead.

Honest residual, by design: the job role's grant confines the event *source*,
not its contents, so a job can emit step events claiming another job's
identity within its own run. Step rows are therefore **display-plane, never
decision-plane** — they feed check content and `runs show`; terminal
authority for jobs is always `BatchGetBuilds` (spec §7.8).

Deploying bundles the launcher, poller, and other control-plane Lambda
handlers with esbuild (a regular dependency of this package) — no Docker
required.

## Tier-1 poller

An EventBridge Scheduler tick (`pollCadence` rate, one-minute jitter window)
drives a **non-VPC** zip Lambda — non-VPC is load-bearing: SSH egress through
a NAT gateway (~$32/mo) would dominate the stack's cost. Each tick runs
protocol-v2 `ls-refs` over pure-JS ssh2 against every configured repo (8
parallel sessions), diffs the full `refs/heads/*` + `refs/tags/*` namespace
against the polling table's compressed last-seen map, **emits the diff events
and only then commits the new map** — a crash between the two re-emits, and
the launcher's content-derived dedupe absorbs the duplicates.

Operational behavior:

- **Overlap**: reserved concurrency 1 turns an overlapping tick into a Lambda
  throttle; the `<name>-poller-overlap` alarm fires on sustained throttling.
  Last-tick duration is the `TickDurationMs` metric (`Millwright/Poller`).
- **Degradation**: SSH transport failures across ≥3 repos in one tick open a
  circuit breaker (alarm `<name>-poller-circuit-breaker`); polling drops to a
  single canary repo on a decaying schedule until one probe succeeds.
  "Repository not found" or a rejected deploy key quarantines just that repo,
  with its own decaying retry.
- **Host keys**: pinned from `/millwright/<name>/github/host-keys` (GitHub's
  published keys are compiled in as day-one defaults). A mismatching key is
  auto-reconciled only when GitHub's `/meta` endpoint confirms the rotation —
  persisted poller-side and alarmed (`<name>-poller-host-key-rotation`);
  anything else hard-fails that repo's poll. `millwright refresh-host-keys`
  refreshes the SSM pin itself.
- **Growth path** (documented, not built): past ~100 repos a single tick no
  longer fits the cadence comfortably — shard the schedule by repo prefix,
  i.e. several schedules each invoking the poller for a disjoint slice of the
  repo namespace.

## The synth phase (spec §7.2)

Every run's first step is a **synth job**: a CodeBuild build on the single
`<deploymentName>-builds` project that clones the watched repo at the
triggering commit (deploy key, host keys pinned from SSM; PR runs add one
extra fetch of `+refs/pull/N/head` from the base repo's namespace), installs
dependencies by lockfile discovery, runs the control plane's own synth
tooling (an esbuild bundle delivered as a CDK S3 asset — never resolved from
the watched repo), and writes `model.json` + `source.tar.gz` to the run's
`in/` prefix. The image is the full `public.ecr.aws/docker/library/node:22`,
pinned by digest per release (`src/synth-image.ts`, refreshed with
`node scripts/pin-synth-image.mjs`).

The synth job executes repo-controlled code and is treated as a trust
boundary: its role (`<deploymentName>-synth-job`) reads deploy keys,
host-key pins and repo config, writes only `runs/*/in/*`, and has **no
DynamoDB access**. The registry entry the launcher matches events against is
written by the control-plane **post-synth step**
(`<deploymentName>-post-synth`), which re-reads `model.json` from S3,
schema-validates it, rejects models claiming a different repo or commit, and
only then writes `REG#<repo>` / `REF#<ref>` — plus the `<workflow> / synth`
(or, for bootstrap synth-only executions, `millwright / synth`) check
desired state.

## The shim data plane (spec §12, §11.2)

Job images carry "Linux + POSIX shell, nothing more", so all data-plane work
runs through the delivered shim binary. `src/runtime/shim/` implements the
subcommands the shared buildspec renderer authors:

- `source unpack` — extracts `source.tar.gz` (jobs never clone) with a
  dependency-free tar reader; path traversal in an archive is refused.
- `artifact upload` / `artifact fetch` — objects under
  `out/<job>/<artifact>/<workspace-relative-path>`. Upload derives its
  destination from the job's own dispatch identity (`MILLWRIGHT_JOB`); no
  invocation can name another job's subtree, and the job role's IAM policy
  (spec §10.2) enforces the same boundary underneath. Fetch may read any
  producer — run-wide artifact read is deliberate. Loose artifact objects do
  not carry file modes (v1 limit); caches, which travel as tar.gz, do.
- `cache restore` / `cache save` — exact key first, then `restoreKeys`
  prefixes in order (newest object wins); an exact hit drops a marker that
  makes the post-build save a no-op, and save also skips when the key
  already exists (cache write trust is repo-scoped — first writer wins).

The `MILLWRIGHT_OUT_URI`/`MILLWRIGHT_CACHE_URI` env vars carry `s3://` URIs
in the cloud and plain directory paths under the local runner; the commands
are identical in both.

Pinned physical names this construct honors or introduces:

| Name | What |
|---|---|
| `<deploymentName>-builds` | C11 — the single CodeBuild project (pinned by the run-executor issue, created here). |
| `<deploymentName>-synth` | Synth phase Lambda: starts the synth build, which completes the machine's task token via the synth-events completer. |
| `<deploymentName>-post-synth` | Post-synth validation/registry Lambda. |
| `<deploymentName>-synth-job` | The synth build's service role. |
| `<deploymentName>-run-executor` | The state machine (launcher-pinned) whose tokens the completer finishes. |

## IAM model: stable two-variant job roles

User jobs never get per-run roles (IAM's eventual consistency would put a
propagation wait on every dispatch, and role quotas are finite). Instead each
(repo, workflow, job) owns a stable pair of roles under the
`/millwright/<deploymentName>/jobs/` path, named `mw-…-fg` / `mw-…-ns`,
boundary-attached and tagged:

- **no-secret-grants** (`-ns`) — what every untrusted ref (PRs included)
  dispatches under. Nothing in it derives from a `model.json`: run-input and
  artifact reads, writes confined to the job's own `out/<job>/` prefix,
  repo-scoped cache access, step events, build logs, and pulls from the
  operator-allowlisted `ecrPullRepos` — plus an explicit deny on deploy keys
  and no DynamoDB access at all.
- **full-grants** (`-fg`) — the same baseline plus the model-declared secret
  grants (`ssm:GetParameters` on exactly the declared params, `kms:Decrypt`
  on the config CMK, `secretsmanager:GetSecretValue` on declared passthrough
  ARNs). Created and updated only from validated models of refs matching the
  repo's `secretsAllowedRefs`; the decider verifies a stored policy hash at
  dispatch and reconciles on mismatch, absorbing the IAM propagation wait
  (bounded, ~60 s) only on grant-changing runs of trusted refs.

The control-plane roles that touch this namespace are escalation-guarded:
`iam:CreateRole`/`iam:PutRolePolicy` are conditioned on the deployment's
permissions boundary being attached, and `iam:PassRole` is pinned to
`codebuild.amazonaws.com` within the `mw-*` namespace — a decider driven by a
hostile `model.json` cannot mint or pass an unbounded role. Role pairs whose
(workflow, job) disappears from every registry entry are swept after 30 days.

Accepted, stated losses of the stable-role design:

- **No cross-run artifact isolation within one workflow** — run N can read
  run M's artifacts. The threat model already executes repo code, so the
  boundary that matters is per-(repo, workflow, job), not per-run.
- **Cache-write trust is repo-scoped** — exact-key write scoping was
  illusory, since any branch computes the shared key legitimately.
- **Trusted refs with differing models churn the full variant's policy** —
  rare in practice, bounded by the dispatch-time reconcile.
