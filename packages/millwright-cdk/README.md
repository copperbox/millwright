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

Still owned by later issues: the concurrency-group hand-off on run completion
(spec §8.4), check desired-state writes (§13.2), and job-role variant
selection at dispatch (§10.2). Dispatch renders every job's buildspec through
the shared control-plane renderer (§7.4) from `@copperbox/millwright-state`.

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

Deploying bundles the Lambda handlers with esbuild (a regular dependency of
this package) — no Docker required.
