# Update Log

## 2026-08-12
* Fix spec citation path
* **Creation**: Created [Deferred and out of scope for v1](/deferred-and-out-of-scope.md).
* **Creation**: Created [Cost and latency expectations](/operations/cost-and-latency.md).
* **Creation**: Created [Degradation, quarantine, and the sweep](/operations/degradation.md).
* **Creation**: Created [Local execution](/architecture/local-execution.md).
* **Creation**: Created [Job execution environment](/architecture/job-execution-environment.md).
* **Creation**: Created [CLI command surface](/interfaces/cli.md).
* **Creation**: Created [Workflow definition API](/interfaces/workflow-definition-api.md).
* **Creation**: Created [Deployment shape and CLI discovery](/interfaces/deployment.md).
* **Creation**: Created [Packages and release model](/interfaces/packages.md).
* **Creation**: Created [The run model (synth output)](/schemas/run-model.md).
* **Creation**: Created [S3 layout — artifacts and caches](/schemas/s3-layout.md).
* **Creation**: Created [SSM config plane](/schemas/ssm-config-plane.md).
* **Creation**: Created [Polling table (DynamoDB)](/schemas/polling-table.md).
* **Creation**: Created [State table (DynamoDB)](/schemas/state-table.md).
* **Creation**: Created [Cron and manual dispatch](/architecture/cron-and-dispatch.md).
* **Creation**: Created [Check reporting to GitHub](/architecture/check-reporting.md).
* **Creation**: Created [Fork PRs and PR shas](/security/fork-pr-policy.md).
* **Creation**: Created [GitHub auth — deploy keys and the App](/security/github-auth.md).
* **Creation**: Created [Control-plane role inventory](/security/control-plane-roles.md).
* **Creation**: Created [secretsAllowedRefs — the matcher and the gate](/security/secrets-gating.md).
* **Creation**: Created [Per-run job roles were dropped](/decisions/stable-job-roles.md).
* **Creation**: Created [Job roles — stable, two-variant](/security/job-roles.md).
* **Creation**: Created [permissionsBoundary is a required construct prop](/security/permissions-boundary.md).
* **Creation**: Created [Trust model — repo code is the adversary](/security/trust-model.md).
* **Creation**: Created [The per-ref registry](/architecture/per-ref-registry.md).
* **Creation**: Created [Concurrency groups](/architecture/concurrency-groups.md).
* **Creation**: Created [Writer partitioning of the state table](/architecture/writer-partitioning.md).
* **Creation**: Created [Status algebra, cancellation, and rerun](/architecture/status-algebra.md).
* **Creation**: Created [BatchGetBuilds is authoritative for terminal job state](/decisions/batchgetbuilds-authoritative.md).
* **Creation**: Created [Caught-timeout wake instead of task heartbeats](/decisions/no-heartbeat-wake.md).
* **Creation**: Created [Decider loop and the task-token protocol](/architecture/decider-loop.md).
* **Creation**: Created [The synth job and its trust boundary](/architecture/synth-job.md).
* **Creation**: Created [Run start — the launcher sequence](/architecture/run-start.md).
* Fix relative links
* **Creation**: Created [The poller is non-VPC](/decisions/non-vpc-poller.md).
* **Creation**: Created [Why polling instead of webhooks](/decisions/no-webhooks.md).
* **Creation**: Created [Emit-then-commit ref diffing](/architecture/emit-then-commit.md).
* **Creation**: Created [Polling architecture](/architecture/polling.md).
* **Creation**: Created [Component map](/architecture/components.md).
* Initial brain population: millwright overview
