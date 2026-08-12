---
type: schema
title: State table (DynamoDB)
tags:
  - millwright
  - dynamodb
  - schema
  - orchestration
timestamp: 2026-08-12T21:26:18.159Z
---

Single-table, on-demand DynamoDB. **The CLI's source of truth.** TTL 90 days on all items **except
`REG#` rows** (`retention.metadata` prop).

| Item | PK | SK | Notes |
|---|---|---|---|
| Run counter | `WF#<repo>#<workflow>` | `COUNTER` | Atomic increment by launcher. |
| Run | `WF#<repo>#<workflow>` | `RUN#<inverted zero-padded number>` | Status (incl. PENDING/QUEUED), trigger kind, ref, sha, timestamps, `cancelRequested`, `rerunOf`, `reason`, **current task token**, original-start timestamp (deadline anchor). |
| Job | `RUN#<repo>#<workflow>#<number>` | `JOB#<name>` | Projection of CodeBuild state; build id/ARN, log stream, timings, `reusedFrom`, skip reason. |
| Step | `RUN#<repo>#<workflow>#<number>` | `JOB#<name>#STEP#<index>` | Written by C19 from shim events; **display-plane only**. |
| Event dedupe / processing record | `EVENT#<repo>#<ref>#<sha>#<kind>` | `-` | Conditional put; **TTL 30 min**; run id written on creation for idempotent launcher retries. |
| Build mapping | `BUILD#<build-id>` | `-` | Run/job identity for the build-events handler; short TTL past terminality. **No GSI.** |
| Concurrency group | `GROUP#<key>` | `-` | `running`, `pending`; conditional/transactional writes. |
| Registry | `REG#<repo>` | `REF#<ref>` | Written by control-plane code **post-validation**; `schemaVersion`, per-workflow `{triggers, concurrency}`. **TTL-exempt.** |
| Check state | `CHECK#<repo>#<sha>` | `CTX#<context>` | `desired`, `reported`, `check_run_id`, **`ownerRun`**, backoff state, abandoned flag. |

Run numbers are stored **inverted and zero-padded** (width 12) so that a plain `Query` returns
newest-first without a reverse scan — `runs list` and latest-run defaults depend on it.

## Two invariants worth internalizing

1. **The state table is never a credential store.** It is not CMK-encrypted and is the most widely
   readable item in the system. Credentials live in the [SSM config plane](ssm-config-plane.md).
2. **Job rows are a projection, not the truth** — terminal authority is
   [`BatchGetBuilds`](../decisions/batchgetbuilds-authoritative.md).

Every item class has exactly one writer — see
[Writer partitioning](../architecture/writer-partitioning.md).

Code: `packages/millwright-state/src/keys.ts`, `items.ts`, `ttl.ts`.

# Citations

[1] [Spec §9.1](../../docs/specs/1-millwright-v1-implementable-specification.md)
