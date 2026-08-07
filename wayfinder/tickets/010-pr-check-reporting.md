---
id: "010"
title: PR check reporting
type: wayfinder:grilling
status: closed
assignee: dan
blocked-by: ["003"]
---

## Question

How do millwright run results appear on GitHub PRs — check runs vs commit statuses,
support for required-check gating, and what happens when the GitHub API is degraded
(queue and replay results once it recovers?). Blocked on
[Repo access auth](003-repo-access-auth.md): what we can post depends on how we
authenticate (check runs require a GitHub App).

## Resolution

**Check runs via the GitHub App, reconciled from DynamoDB desired state, posted
per-commit unconditionally.**

- **Mechanism**: check runs are primary (App auth); deployments on the fine-grained-PAT
  fallback degrade to commit statuses with the **same context names**, so
  branch-protection rules work identically in both modes.
- **Granularity**: one check per job, named `<workflow> / <job>` (GHA naming
  convention; job names are synth-validated, so contexts are stable for required-check
  gating). No run-level rollup check in v1 — addable later as a new context.
- **Lifecycle**: the job list doesn't exist until synth runs at the triggering commit,
  so run start creates a single **`millwright / synth`** check (`in_progress`). Synth
  success completes it and batch-creates per-job checks as `queued`; jobs go
  `in_progress` on dispatch and complete with `success`/`failure`/`cancelled`/`skipped`.
  Synth failure fails the synth check with the error in its summary — a broken
  `workflows.ts` is always visible on the PR. Docs recommend requiring
  `millwright / synth` in branch protection.
- **Architecture — desired-state reconciliation, not an event queue**: the decider
  upserts a check item per (commit SHA, context) in the existing single-table
  (`desired` state, `reported` state, `check_run_id`). A reporter Lambda fires off
  **DynamoDB Streams** (Lambda-triggered GetRecords are free) for the happy path;
  unconverged items fall to the existing 1-minute scheduler sweep. The reporter always
  posts the *latest* desired state and records what GitHub ACKed — outage replay
  coalesces to one call per check, and out-of-order updates are structurally
  impossible. This satisfies the durable-queue constraint radiated by
  [Repo access auth](003-repo-access-auth.md).
- **Scope**: every cloud run reports to its commit SHA, PR or not — checks attach to
  SHAs and GitHub surfaces them on any PR with that head, so PR reporting **never
  depends on tier-2 PR polling**. Local runs never report (parity decision: zero
  AWS/GitHub calls). Budget ≈ 1,500 calls/day vs the 5,000/hr App limit.
- **Degradation policy**: immediate post on stream; on failure, per-item exponential
  backoff (1 m → 15 m cap) under the sweep, honoring `Retry-After`. Unconverged after
  **7 days** → marked abandoned (visible in `runs show`), sweep stops; 90 d table TTL
  clears it. Duplicate creates from crash windows are benign (latest-wins per name/SHA
  on both surfaces). No staleness cutoff below the horizon — a late flush is still true
  for its SHA and can never bless a newer commit.
- **Content**: job-check summary markdown carries run number, per-step
  conclusions/durations, the failed step with its last log lines, and the triage
  command (`millwright logs ci#142 --failed`); details URL deep-links to the job's
  CloudWatch Logs stream. PAT mode gets a ~140-char status description + URL.
- **V1 omissions**: no file/line annotations (nothing produces structured file/line
  data yet — fog); no check-run re-run button (GitHub delivers requested actions via
  webhook only — rerun stays in the CLI; the button could ride the opportunistic
  webhook fast-path if that ever lands).
