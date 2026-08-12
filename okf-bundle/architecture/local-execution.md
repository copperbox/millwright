---
type: architecture
title: Local execution
tags:
  - millwright
  - local
  - cli
  - orchestration
timestamp: 2026-08-12T21:28:03.950Z
---

**`millwright run <wf>` is always local; `millwright dispatch <wf>` is always cloud.** No flag
crosses that line.

## Shared core, two thin hosts

Local parity is achieved by **reusing the actual control-plane logic**, not by reimplementing it:

- The **pure decider library** and the **step shim** run in-process.
- Two interfaces are swapped:
  - `Executor` — `StartBuild` ↔ `docker run`
  - `StateSink` — DynamoDB ↔ `.millwright/runs/local-N.json`

Everything that matters is therefore identical by construction: same DAG logic, same SKIPPED
semantics, same terminal states. Ctrl-C sets `cancelRequested` through the same path as
`runs cancel`.

If you are changing decider or shim behavior, you are changing both hosts at once. That is the
intent — a fix that only lands in one is a bug.

## Where local deliberately differs

- **Image pull/auth**: cloud pulls need the `ecrPullRepos` config entry **and** the ECR repository
  resource policy; local uses **the user's own docker config**.
- **Concurrency groups are carried, not enforced.** The definition is read; the gate is not applied.
- **Local runs never report checks** to GitHub.
- Secrets come from `--secrets-file`, not the [SSM plane](../schemas/ssm-config-plane.md).

## Inner loop

`--job X [--with-deps]`, artifact reuse across invocations, `--clean`, `--as-tag <tag>` (run as
though triggered by a tag), typed-input prompting, `--parallel N`, and host-socket mounting for
privileged jobs.

Code: `packages/millwright-cli/src/local/`, decider in
`packages/millwright-state/src/decider.ts`.

# Citations

[1] [Spec §14](../../docs/specs/1-millwright-v1-implementable-specification.md)
[2] [Running workflows locally](../../docs/local-execution.md)
