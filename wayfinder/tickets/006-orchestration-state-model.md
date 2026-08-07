---
id: "006"
title: Orchestration and state model
type: wayfinder:grilling
status: closed
assignee: dan
blocked-by: ["001"]
---

## Question

What orchestrates a run — executing the job DAG, retries, timeouts, fan-out, cancellation
— and what stores run/job state and history? Candidates: Step Functions driving the
compute, DynamoDB + EventBridge choreography, or a hybrid. Blocked on
[Job compute runtime](001-job-compute-runtime.md): the compute choice changes what
orchestration is natural (e.g. Step Functions has first-class CodeBuild/ECS
integrations).

Constraints radiated from [Run observability DX](005-run-observability-dx.md): the
state store must serve `runs list` (most-recent-first per workflow, filterable by
ref/status), an atomic per-workflow run counter (`ci#142` identity), per-step status
records including SKIPPED, and it owns the semantics of `millwright runs rerun`.

## Resolution

Decided live with Dan (2026-08-07). **Hybrid: Step Functions Standard executes the run;
DynamoDB is the single queryable source of truth the CLI reads.** Pure choreography was
rejected (hand-rolls what SFN sells for pennies); SFN-only was rejected (its history
can't serve the CLI's query needs).

**Run start.** EventBridge rule → **launcher Lambda**: dedupes the event (conditional
put on event id — EventBridge is at-least-once), atomically increments the per-workflow
run counter (`ci#142`), writes the run record PENDING, calls `StartExecution`. First
state machine step is a **synth job on CodeBuild** at the triggering commit; the
declarative job model lands as JSON in the run's S3 prefix. *Escape hatch*: if the
[provisioning-latency spike](012-codebuild-provisioning-latency-spike.md) comes back
bad, move the synth job to CodeBuild **Lambda compute mode** (synth needs no docker) —
a tuning knob, not an architecture change.

**Execution: dispatch-on-completion decider loop** (wave-based Map+`.sync` rejected for
its level-barrier scheduling wart). One generic, deployed-once state machine loops a
**decider Lambda**: read job model + job states from DynamoDB → fire-and-forget
`StartBuild` for every job whose deps just completed → wait on `waitForTaskToken`
(~30 s heartbeat). A build-state EventBridge event handler updates DynamoDB and sends
the token, so the loop wakes instantly on any completion; the decider reconciles via
`BatchGetBuilds` as belt-and-braces. Per-job retries and timeout policy are interpreted
in the decider's TypeScript (CodeBuild enforces the hard per-build timeout). **The
decider is the DAG brain and is reused in-process by the local runner** — this sealed
the choice.

**Failure semantics.** Transitive dependents of a failed job → SKIPPED with
`reason: upstream_failed` (distinct from `reason: skip_if`); independent branches run
to completion. Run status: FAILED if any job FAILED/TIMED_OUT; CANCELLED if cancelled;
SUCCEEDED iff every job SUCCEEDED or was SKIPPED via guard. **No fail-fast in v1**
(sent to fog); **no soft-fail/allow-failure in v1** (ruled out of scope).

**Cancellation is decider input, not an outside kill.** CLI writes `cancelRequested`
on the run record and sends the task token; the decider `StopBuild`s in-flight builds,
marks every non-terminal job CANCELLED, marks the run CANCELLED, and exits the loop
cleanly. `StopExecution` is documented break-glass only. Local runner Ctrl-C sets the
same flag through the same path.

**Rerun.** `runs rerun` creates a **new run** (fresh number, `rerunOf` metadata) from
the **stored job model** — no re-synth, so reruns skip the synth job and start faster.
`--failed` reruns FAILED/TIMED_OUT/CANCELLED jobs plus their SKIPPED dependents: the
launcher prefix-copies succeeded jobs' artifacts into the new run's S3 prefix (per-run
IAM intact) and the decider seeds those jobs terminal SUCCEEDED with `reusedFrom`.
Nothing failed → `--failed` rejects with "nothing to rerun".

**Step-level status: in-build step shim writes DynamoDB directly** (post-hoc log
parsing rejected as brittle, no live visibility). Each generated buildspec wraps steps
in a shim that records start/end/status/skip-reason; IAM `dynamodb:LeadingKeys`
condition confines each job role to its own run's items. Writers are partitioned, never
overlapping: launcher (counter, run create, dedupe), decider (run + job rows), shim
(own step rows), CLI (`cancelRequested` only).

**State table** (one DynamoDB table, on-demand; polling keeps its own table):

| Item | PK | SK |
|---|---|---|
| Run counter | `WF#<repo>#<workflow>` | `COUNTER` |
| Run | `WF#<repo>#<workflow>` | `RUN#<inverted zero-padded number>` |
| Job | `RUN#<repo>#<workflow>#<number>` | `JOB#<name>` |
| Step | `RUN#<repo>#<workflow>#<number>` | `JOB#<name>#STEP#<index>` |
| Event dedupe | `EVENT#<event-id>` | `-` |

Inverted run number ⇒ `runs list` is one Query, most-recent-first; ref/status filters
are FilterExpressions (GSI only if a filter gets hot — not v1 structure); one Query
per partition serves `runs show`. TTL 90 days on all items (logs' 30 days is CloudWatch
retention config, separate).

**Constraints radiated**: the launcher sees every run before `StartExecution` and is
the natural gate for [Concurrency semantics](015-concurrency-semantics.md) (graduated
from fog by this resolution). [Local execution parity](007-local-execution-parity.md)
reuses the decider and step shim in-process against a local state file.
[PR check reporting](010-pr-check-reporting.md) can consume run/job transitions from
the state table or from decider-emitted events — its choice.
