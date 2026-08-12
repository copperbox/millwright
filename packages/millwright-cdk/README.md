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

The launcher consumes events through an SQS queue; failed deliveries retry on
the visibility timeout, which is also how a first-push bootstrap replays once
its synth-only execution has written the per-ref registry.

Deploying bundles the launcher and poller handlers with esbuild (a regular
dependency of this package) — no Docker required.

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
