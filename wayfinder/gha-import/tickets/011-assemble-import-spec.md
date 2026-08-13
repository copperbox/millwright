---
id: "011"
title: Assemble the import spec
type: wayfinder:task
status: open
assignee: none
blocked-by: ["001", "002", "003", "004", "005", "006", "007", "008", "009", "010", "012"]
---

## Question

Compile every resolution on this map into the implementable spec — the map's terminus.

**Preconditions** (both must hold before this ticket may close):

1. Every other ticket on the map is closed.
2. **The map's `## Not yet specified` section is empty** (Note 8). Every fog item must
   have graduated into a ticket and been decided, or been explicitly ruled **Out of
   scope**. At charting time the fog held: composite action translation depth,
   re-import and drift, the fleet migration playbook, and fleet-scale aggregate
   reporting. Nothing may be carried into the spec as an open question.

**Deliverables** — both are required for the destination to be reached:

1. **`spec/millwright-import.md`**, a sibling to `spec/millwright-v1.md`. Follow that
   document's conventions: numbered sections, a component/behavior inventory, concrete
   signatures and examples, and — critically — its **§17/§18 pattern** of an explicit
   amendments section (where later tickets amended earlier ones, reconciled
   later-wins) and a spec-authored-fills section (where assembly had to invent
   something no ticket decided, flagged for a build-time design pass).
2. **A post in the [AI Spec Council](https://github.com/copperbox/millwright/discussions)
   discussions category** (`DIC_kwDOTwxxcs4DC1_U`), mirroring the v1 spec's
   Discussion #1.

**Structure to cover**, drawn from the tickets: what `millwright import` is and
explicitly is not (Note 1 — disposable, no fidelity promise); the translation model
(triggers, expressions and conditionals, the job DAG and matrices, the curated action
table, shared-workflow inlining); the hole contract and report format; generated-code
shape and overwrite policy; the CLI surface and self-verification; and a coverage
table stating, per GHA feature, what the importer does — the honest map of what
migrates and what you'll do by hand.

Also carry forward, prominently: the findings list (ticket 010) is a **separate**
handoff, not part of this spec.
