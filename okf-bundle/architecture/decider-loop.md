---
type: architecture
title: Decider loop and the task-token protocol
tags:
  - millwright
  - orchestration
  - stepfunctions
  - codebuild
timestamp: 2026-08-12T21:23:17.345Z
---

**Dispatch-on-completion.** One generic Step Functions Standard machine loops the decider Lambda.
The decider itself is a **pure library** (`packages/millwright-state/src/decider.ts`) reused
in-process by the [local runner](local-execution.md) — same DAG logic, same SKIPPED semantics, same
terminal states.

Each iteration: read `model.json` from S3 (cached in-process across iterations) + job states from
DynamoDB, treat [`BatchGetBuilds` as authoritative](../decisions/batchgetbuilds-authoritative.md)
for terminal job states, fire `StartBuild` for every job whose dependencies just completed, then
wait on the task token.

## Token protocol — no heartbeat

- The decider writes the current iteration's task token **onto the Run item** before entering the
  wait.
- The token-wait state carries **`TimeoutSeconds: 60` with a `Catch` on `States.Timeout`** back into
  the decider, which reconciles via `BatchGetBuilds`.
- **No component sends `SendTaskHeartbeat`; no heartbeat sender exists.** The build-events handler
  is the low-latency wake; the timeout is the safety net that *also* catches completions landing
  between token generations.
- Senders (build-events handler, CLI cancel) read the token from the Run item, `SendTaskSuccess`
  best-effort, and **swallow `TaskTimedOut`/`InvalidToken`**. Wakes are idempotent because the
  decider re-reads `cancelRequested`, job states, and CodeBuild ground truth on every entry.

See [Why no heartbeat](../decisions/no-heartbeat-wake.md) for the reasoning.

## Build → run mapping

A `BUILD#<build-id>` item written by the decider at dispatch, carrying run/job identity, with a
short TTL past run terminality. **No GSI** — the mapping item is the lookup.

## Bounded by contract

- **Per-job total-attempt cap, default 3**, model-overridable.
- **Run-level wall-clock deadline, default 24 h**, model-overridable up to CodeBuild's 36 h ceiling,
  enforced by the decider's clock and **anchored to the original run start across carry-overs**.
- A stuck run therefore dies a *managed* death (jobs TIMED_OUT, run FAILED, checks reported) before
  the Step Functions history ceiling could kill the execution unmanaged.

## Carry-over re-execution

When an execution approaches its iteration budget, its terminal state `StartExecution`s a fresh
execution of the same machine, resuming from table state (token on the Run item, CodeBuild as
ground truth). This makes the 25,000-event history cliff a non-event.

The sweep repairs concurrency-group slots; it does **not** resurrect executions. The caps above are
what prevent dead executions from existing in the first place.

## Per-job dispatch

One `StartBuild` per job on the single CodeBuild project, with per-run overrides: image,
`computeTypeOverride`, `environmentTypeOverride` (the ARM↔x86 switch),
**`imagePullCredentialsTypeOverride: SERVICE_ROLE`** (without it, job-role ECR grants are inert
under the `CODEBUILD` default), privileged mode, env, timeout, service role (the job's stable role
variant), inline buildspec.

The buildspec is rendered by a **shared control-plane library** (`millwright-state/src/buildspec.ts`,
used by the synth step, the decider, and the local runner): synth emits the step list and declared
env names; the control plane renders the prelude, shim-wrap, and artifact/cache paths. **Repo code
never authors the buildspec that wraps it.** CodeBuild's built-in `QUEUED` phase is the only queue.

## Related

- [Status algebra](status-algebra.md)
- [Job execution environment](job-execution-environment.md)

# Citations

[1] [Spec §7.3, §7.4](../../docs/specs/1-millwright-v1-implementable-specification.md)
[2] [run-executor-definition.ts](../../packages/millwright-cdk/src/run-executor-definition.ts)
