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
(spec §8.4), check desired-state writes (§13.2), job-role variant selection
at dispatch (§10.2), and the shared buildspec renderer (§7.4) — the decider
currently dispatches with an interim plain-steps buildspec.

Deploying bundles the Lambda handlers with esbuild (a regular dependency of
this package) — no Docker required.
