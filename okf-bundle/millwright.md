---
type: overview
title: Millwright
tags:
  - millwright
  - v1
  - architecture
timestamp: 2026-08-12T21:21:33.655Z
---

Millwright is a **single-tenant CDK application that replaces GitHub Actions *execution*** with
polling-driven CI/CD running in the operator's own AWS account. GitHub stays the source of truth for
code and collaboration; millwright does no git hosting and no PR/review UX.

As of v1 the spec is implemented across four npm packages (see [Packages](interfaces/packages.md)).
The project is early alpha: never deployed outside development, no upgrade path between versions.

## Framing invariants

These bound every other decision in the system. Treat a proposal that violates one as wrong until
the invariant itself is renegotiated.

- **No webhook dependency.** Triggering is poll-driven in two tiers — see
  [Polling architecture](architecture/polling.md) and [Why no webhooks](decisions/no-webhooks.md).
- **Workflows are code, CDK-style**: TypeScript constructs in the watched repo, synthesized to a
  declarative run model *at the triggering commit*. No GitHub Actions YAML compatibility in v1.
  See [Workflow definition API](interfaces/workflow-definition-api.md).
- **The exact workflow runs locally without pushing** (`millwright run`), sharing the cloud's
  decider library and step shim. See [Local execution](architecture/local-execution.md).
- **Single-tenant**: each team deploys into their own AWS account. No multi-tenancy anywhere, no
  hardcoded account assumptions.
- **As serverless as possible**: the only standing costs are a KMS CMK (~$1/mo) and the polling
  Lambda (~$1–3/mo). See [Cost and latency](operations/cost-and-latency.md).

## The load-bearing tension

Workflow definitions are **repo-editable code that the control plane executes** (in the synth job).
Almost every security decision in millwright follows from taking that seriously — see
[Trust model](security/trust-model.md). If you are reasoning about a change and it is not obvious
why something is split the way it is, that concept is usually the answer.

## Where to start

- [Component map](architecture/components.md) — the C1–C19 inventory and what each piece owns.
- [Run start](architecture/run-start.md) → [Decider loop](architecture/decider-loop.md) — the hot path.
- [State table](schemas/state-table.md) — the CLI's source of truth.
- [Deferred and out of scope](deferred-and-out-of-scope.md) — what was deliberately *not* built,
  so it isn't re-proposed as an oversight.

# Citations

[1] [Millwright v1 implementable specification §1](../docs/specs/1-millwright-v1-implementable-specification.md)
[2] [README](../README.md)
