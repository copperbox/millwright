---
type: schema
title: The run model (synth output)
tags:
  - millwright
  - schema
  - security
  - workflows
timestamp: 2026-08-12T21:26:52.254Z
---

`millwright synth` emits **one JSON document** — the contract between the definition library, cloud
orchestration, and the local runner. Cloud synth lands it at `runs/…/<n>/in/model.json`; local synth
holds it in process.

Shape: `schemaVersion`, `repo`, `commit`, `workflows[]` with triggers/concurrency/jobs[]; each job
carries `image`, `compute`, `privileged`, `timeoutMinutes`, `steps` (with optional `skipIf`),
`secrets`, `produces`/`consumes`, `dependsOn`, `cache`.

## model.json is a named privilege boundary

It is **authored inside the synth job, which executes repo-controlled code**. Therefore:

- The control plane **schema-validates** it and treats **every grant it requests** as
  attacker-influenceable.
- Requested IAM is materialized **only by control-plane code**, capped by the
  [permissions boundary](../security/permissions-boundary.md), with secret grants only for
  [allowlisted refs](../security/secrets-gating.md).
- The `(triggers, concurrency)` map is extracted into the
  [per-ref registry](../architecture/per-ref-registry.md) **by control-plane code after
  validation** — never by the synth job.

See [Trust model](../security/trust-model.md).

## Schema compatibility

The model carries a **`schemaVersion`**. The control plane accepts schema **≤ its own**; synth fails
loud otherwise. This governs skew between a repo's `millwright-workflows` version and the deployed
control plane.

Note the asymmetry: the synth **tooling** is always the control plane's own (delivered as a
secondary source), so **only the definition library's schema output** is subject to skew.

Code: `packages/millwright-workflows/src/model.ts`, `schema.ts`;
`packages/millwright-state/src/run-model.ts`.

# Citations

[1] [Spec §5, §3.1](../../docs/specs/1-millwright-v1-implementable-specification.md)
