# decisions

# Concepts

* [BatchGetBuilds is authoritative for terminal job state](batchgetbuilds-authoritative.md)
* [CDK construct tests share one cloud-assembly outdir](cdk-tests-share-one-outdir.md) - Why construct tests build their App with test/support/test-app.ts instead of new App(), and why vitest's timeout is 30 s.
* [Caught-timeout wake instead of task heartbeats](no-heartbeat-wake.md)
* [Why polling instead of webhooks](no-webhooks.md)
* [The poller is non-VPC](non-vpc-poller.md)
* [Per-run job roles were dropped](stable-job-roles.md)
