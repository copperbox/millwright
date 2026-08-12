---
type: security
title: Control-plane role inventory
tags:
  - millwright
  - security
  - iam
timestamp: 2026-08-12T21:25:23.336Z
---

All control-plane roles are **fixed at deploy time**. Only *job-role policies* change at runtime, and
only via the guarded paths in [Job roles](job-roles.md).

| Role | Grants |
|---|---|
| **Poller** | `GetParameters` on deploy keys + host-key pins + repo configs; polling-table read/write; `events:PutEvents` conditioned to `source: millwright.poller`. |
| **Launcher** | state-table writes (its [partition](../architecture/writer-partitioning.md)), `states:StartExecution`, S3 get/copy/put across `runs/<repo>/<wf>/*` for the rerun prefix-copy. |
| **Synth job** | deploy-key + host-key-pin + repo-config reads; `s3:PutObject` on the run's `in/` prefix. **No DynamoDB.** |
| **Decider** | state table (its partition), `s3:GetObject` on `runs/…/in/*`, `StartBuild`/`StopBuild`/`BatchGetBuilds`, role reconciliation **with escalation guards**. |
| **Build-events handler** | job-row updates via `BUILD#` lookup; `states:SendTaskSuccess`/`SendTaskFailure`. |
| **Step-events writer (C19)** | step-row writes only. |
| **Reporter** | state table + stream; App-token minting (reads the App PEM); sole owner of check reconciliation. |
| **Sweep** | group repair (`states:StartExecution`), stale-role housekeeping (same IAM conditions as the decider). |
| **CLI (operator IAM)** | `cancelRequested` write, `states:SendTaskSuccess`, `events:PutEvents` conditioned to `source: millwright.cli`. |

## The decider's escalation guards

The decider is the only component that mints roles, and it is driven by a `model.json` that repo
code authored. Its IAM grants therefore carry conditions:

- `iam:CreateRole` / `iam:PutRolePolicy` — `iam:PermissionsBoundary` condition pinned to the
  [boundary ARN](permissions-boundary.md).
- `iam:PassRole` — scoped to the `mw-*` namespace with
  `iam:PassedToService: codebuild.amazonaws.com`.

A decider driven by a hostile model cannot mint or pass an unbounded role.

# Citations

[1] [Spec §10.3](../../docs/specs/1-millwright-v1-implementable-specification.md)
