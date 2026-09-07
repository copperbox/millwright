---
id: "006"
title: Job DAG reconstruction
type: wayfinder:grilling
status: open
assignee: none
blocked-by: ["001", "002"]
---

## Question

How does a GHA job graph — `needs:` strings plus upload/download-artifact pairs plus
`strategy.matrix` — become a millwright DAG of typed artifact edges?

millwright derives the DAG from artifacts: `consumes: build.artifacts.dist` **is** the
edge, synth-checked, with `dependsOn` as the escape hatch for artifact-less ordering
and no `needs:` strings anywhere. GHA has the inverse model: `needs:` is primary and
artifacts are an independent side channel. Decide the reconciliation:

- **When `needs:` and an artifact pair agree** — job B `needs: A` and downloads what A
  uploaded — emit `consumes` alone (the edge is implied) or `consumes` **and**
  `dependsOn`?
- **When only `needs:` exists** (ordering with no data flow) → `dependsOn`. Confirm the
  shipped `dependsOn` takes `Job` handles, which forces a declaration-order constraint
  in the generated file — jobs must be emitted in topological order. Decide what
  happens on a GHA cycle (illegal there too, but the importer should fail cleanly).
- **When only an artifact pair exists without `needs:`** — legal in GHA and a race, but
  it tells you the real data dependency. Emit the edge? That *changes* the workflow's
  behavior (adding an ordering GHA didn't guarantee). Arguably a fix, arguably a
  surprise — decide, and decide whether it's reported.
- **Nameless `download-artifact`** (downloads everything) — no `consumes` equivalent.
  Likely a hole; confirm against ticket 002's findings.
- **Artifact name → TS identifier**: GHA artifact names are free-form strings
  (`my build-output!`); `produces` keys are TS property names. Decide the sanitization
  and its collision behavior.

**Matrices.** Note 3 of the v1 map: matrices are loops, not a DSL. Decide:

- `strategy.matrix` with simple axes → a TS loop emitting N jobs. **Job naming** is the
  hard part: names are check-run contexts and must be unique and stable
  (`test (18, ubuntu)` → `test-18-ubuntu`?). Stability matters — renaming breaks
  required-check configuration on the GitHub side.
- `include:` / `exclude:` → loop plus filter, or a literal array of the expanded
  combinations? The expanded form is uglier but far more readable in review.
- `fail-fast` (defaults to **true** in GHA) → no target; v1 ruled out fail-fast. Every
  imported matrix silently changes behavior here. Report it loudly.
- `max-parallel` → no target. Hole or drop-with-report?
- A matrix job that another job `needs:` — in GHA that's a fan-in from all matrix legs.
  With artifact edges, that's N `consumes` entries. Confirm this is expressible.
