---
type: architecture
title: Cron and manual dispatch
tags:
  - millwright
  - polling
  - cli
  - orchestration
timestamp: 2026-08-12T21:26:03.633Z
---

## Cron runs on the poll tick

**There is no separate scheduler.** The poller tick doubles as the cron clock, so cron granularity
is the deployment's `pollCadence`. At the default one-minute cadence a `Trigger.cron` expression
fires per matching minute; with a longer cadence each tick fires at most once per entry, for the
latest matching minute (synth warns about this).

Correctness machinery — all of it blocking for v1 cron:

- A **`last-fired-minute`** attribute per cron entry in the polling table. Each tick computes the
  minutes in `(last-fired, now]` matching the expression and fires **at most the latest one**.
  Bounded catch-up: after a poller outage each entry catches up with **exactly one** run, never the
  whole backlog.
- A deterministic event id **`cron#<repo>#<wf>#<minute>`** flows the standard dedupe item,
  cancelling double-fires exactly.
- **Timezone is UTC.** Standard five fields. There is no timezone option.
- Cron is **ref-less**: entries are read from the repo's **default-branch**
  [registry entry](per-ref-registry.md) (guaranteed to exist by bootstrap) and always run the
  default-branch head.

## Manual dispatch is always cloud

```sh
millwright dispatch <workflow> [--ref <ref>] [--input k=v ...]
```

`millwright run` is always **local**; `millwright dispatch` is always **cloud**. The pairing is
absolute — see [Local execution](local-execution.md).

The CLI puts a `dispatch` event on the bus **under the operator's own AWS credentials**, carrying
workflow, ref, and typed inputs. The ref defaults to the default-branch head and is **resolved to a
sha before the event is emitted**, pinning definition and source together.

Inputs are typed against the workflow's `Trigger.manual` declaration — choices validated, booleans
take `true`/`false`.

The event is emitted with `source: millwright.cli`; **the bus resource policy and the launcher both
reject `dispatch` events from any other source**. Beyond that it takes the uniform launcher path —
no special lane, and it gates through [concurrency groups](concurrency-groups.md) like anything else.

Code: `packages/millwright-cdk/src/runtime/poller/cron.ts`, `cron-tick.ts`;
`packages/millwright-cli/src/dispatch.ts`.

# Citations

[1] [Spec §6.4, §7.1](../../docs/specs/1-millwright-v1-implementable-specification.md)
