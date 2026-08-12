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
