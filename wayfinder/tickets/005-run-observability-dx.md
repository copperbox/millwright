---
id: "005"
title: Run observability DX
type: wayfinder:grilling
status: closed
assignee: dan
blocked-by: []
---

## Question

When a run executes, how does the user watch it? Decide the v1 observability surface:
CLI-first (`millwright runs`, `millwright logs -f`), a minimal web UI, raw CloudWatch,
or some mix. What run history, status, and log-tailing capabilities does the spec
require for v1, and what's explicitly deferred? This decision sizes a significant chunk
of the project.

## Resolution

Decided live with Dan (2026-08-07), grilled one branch at a time.

- **CLI-first; no web UI in v1.** The CLI is already load-bearing (`synth`, `dispatch`,
  `secrets set`); a web UI is a whole new subsystem (hosting, auth, API) that fights the
  serverless/minimal-ops framing. Team-glance visibility is GitHub check runs' job
  ([PR check reporting](010-pr-check-reporting.md)); single-tenant means everyone who
  watches runs already holds AWS credentials, so the CLI needs no auth story and keeps
  working during GitHub outages. Raw CloudWatch remains an escape hatch via deep links
  in CLI output, never the UX.
- **Live watching: run-level interleaved tail.** `millwright logs -f <run>` merges all
  active jobs' CloudWatch streams, docker-compose style — job-name line prefixes plus
  lifecycle markers as jobs start/finish/SKIP; `--job <name>` narrows to one job.
  `runs show <run>` renders the job DAG with per-step status (SKIPPED included — the
  constraint radiated from the workflow-API ticket). Implementation is **polled
  `GetLogEvents` (~2 s), not CloudWatch Live Tail** — Live Tail's $0.01/min sessions
  and session limits buy latency CI logs don't need.
- **History requirements** (storage belongs to
  [Orchestration and state model](006-orchestration-state-model.md)):
  `runs list` most-recent-first, filterable by workflow/ref/status, default page ~20,
  rows = id, workflow, trigger kind, ref + short commit, status, start, duration.
  `runs show` = job DAG + per-job/per-step status and durations + log pointers.
  Retention: deployment-config knobs — run metadata default **90 days**, CloudWatch
  log retention default **30 days**. No log archival to S3, no keep-forever.
- **Run identity: workflow-scoped run numbers** (`ci#142`), GHA-style; an internal
  unique id exists but is never required typing. **Latest-run defaults**: `logs -f`
  and `runs show` with no run argument resolve to the most recent run (scoped by
  `--workflow`), and — because poll-driven triggering means a run starts 30–90 s after
  push — the no-arg form *waits for the run to appear* rather than erroring, so
  `git push && millwright logs -f` just works.
- **Failure triage**: `runs show` points at the culprit inline (failing job, failing
  step, exit code); `millwright logs <run> --failed` prints failed jobs' log tails
  (~100 lines, `--full` for everything); `logs -f` exit code mirrors run result, so
  the push-and-watch gesture is scriptable. `millwright runs rerun <run>` **exists in
  v1** but its semantics belong to the orchestration ticket.

**Deferred** (not v1): web UI; log full-text search; cross-run analytics (duration
trends, flakiness); failure annotation/parsing heuristics; log archival; notifications
and badges (already fog on the map).

**Constraints radiated**: the state model must support the `runs list` query shape, an
atomic per-workflow run counter, per-step status records including SKIPPED, and rerun
semantics — all now noted on
[Orchestration and state model](006-orchestration-state-model.md).
