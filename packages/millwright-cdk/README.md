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

Deploying bundles the launcher handler with esbuild (a regular dependency of
this package) — no Docker required.
