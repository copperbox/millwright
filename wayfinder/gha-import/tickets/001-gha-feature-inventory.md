---
id: "001"
title: GHA feature inventory
type: wayfinder:research
status: closed
assignee: research-subagent
blocked-by: []
---

## Question

What is the complete surface of the GitHub Actions workflow schema, and what is the
proposed disposition of each feature — **translate**, **hole**, or **drop**?

This is the coverage backbone the map's decision tickets consume. It gathers *facts*;
the judgment calls it surfaces land in the downstream grilling tickets.

Enumerate the workflow YAML schema against GitHub's own documentation:

- **Top level**: `name`, `run-name`, `on`, `env`, `defaults`, `concurrency`,
  `permissions`, `jobs`
- **`on:`**: `push`, `pull_request`, `pull_request_target`, `schedule`,
  `workflow_dispatch`, `workflow_call`, `workflow_run`, `release`, `issue*`, and the
  filter sub-keys (`branches`, `branches-ignore`, `tags`, `paths`, `paths-ignore`,
  `types`)
- **Job level**: `runs-on`, `needs`, `if`, `strategy` (`matrix`, `include`, `exclude`,
  `fail-fast`, `max-parallel`), `container`, `services`, `env`, `defaults`, `outputs`,
  `permissions`, `environment`, `concurrency`, `timeout-minutes`, `continue-on-error`,
  `uses` + `with` + `secrets` (reusable workflows)
- **Step level**: `uses`, `run`, `with`, `env`, `if`, `name`, `id`, `shell`,
  `working-directory`, `continue-on-error`, `timeout-minutes`
- **Contexts and expressions**: `github`, `env`, `vars`, `secrets`, `job`, `steps`,
  `runner`, `needs`, `inputs`, `matrix`, `strategy` — plus the function library
  (`contains`, `startsWith`, `endsWith`, `format`, `join`, `toJSON`, `fromJSON`,
  `hashFiles`, `success`, `always`, `cancelled`, `failure`)
- **Workflow commands** (`::set-output`, `$GITHUB_OUTPUT`, `$GITHUB_ENV`,
  `$GITHUB_STEP_SUMMARY`, `::add-mask::`, `::group::`) — these appear inside `run:`
  shell and are easy to miss
- **Composite actions** (`./.github/actions/*`) — how they're structured and how
  commonly they're used, feeding the map's fog item on translation depth

For each feature record: what it does, whether the shipped
`@copperbox/millwright-workflows` API has an equivalent (check the **code**, not
`spec/millwright-v1.md`), and a proposed disposition with a one-line rationale.

Where a feature has no millwright equivalent, distinguish **structurally impossible**
(the model has no such concept — e.g. job outputs, soft-fail) from **merely
unsupported** (could be expressed but isn't yet).

Known-in-advance answers to confirm or correct, not re-derive: job-level `if:` is a
hole (Note 5); `continue-on-error` / `always()` / `failure()` have no target (v1 ruled
out soft-fail jobs); `needs.x.outputs.y` has no target (millwright has artifacts, not
job outputs); `vars.*` values live in GitHub's settings and are **not visible in the
YAML at all**.

Deliverable: a disposition table capturing the whole schema, on a
`research/gha-feature-inventory` branch, linked from this ticket.

## Resolution

Disposition table for the whole GHA workflow schema: **~30 translate, ~45 hole,
~14 drop**. Asset on branch `research/gha-feature-inventory`,
`research/gha-feature-inventory.md`.

**Five shipped-code facts drive most dispositions**: `StepModel` is `{ run, skipIf? }`
and nothing else (no name, id, env, shell, cwd, timeout, outputs); there is **no env
concept anywhere** in `millwright-workflows`; no expression evaluator (the only
build-time value is the `steps: (inputs) => [...]` factory arg, resolved at synth);
`JobModel` has no outputs and no conditions; steps share no shell state.

All five structurally-impossible items predicted at charting confirmed. **Twelve more
found**: step identity and step outputs (`$GITHUB_OUTPUT` — *intra*-job flow, which
shell cannot paper over since steps share no state); cross-step env export
(`$GITHUB_ENV`, `$GITHUB_PATH`); service containers; **deployment `environment:`** —
the only hole that can silently remove a **human approval gate on production**;
job-level `concurrency` (`ConcurrencyModel` is workflow-scoped); **all trigger
filtering** — `Trigger.pullRequest()` takes no arguments at all, so every PR filter is
lost; free-text/numeric dispatch inputs (`ManualInput` is choice-or-boolean, but
`type: string` is GHA's *default*); cron `timezone:` (UTC-only — silently shifts every
fire time); the webhook event surface beyond `TriggerKind`'s closed 5-member union;
matrix scheduling (`fail-fast`, `max-parallel`); non-Linux runners; container tuning.

**Corrections to charting's assumptions:**
- **Matrix is not a hole.** Static matrices unroll into N generated `job()` calls at
  codegen. Only `fromJSON(needs.x.outputs.y)` matrices and the scheduling knobs are
  impossible. [Job DAG reconstruction](006-job-dag-reconstruction.md) holds as written.
- **`skipIf` is not a drop-in for step `if:`** — inverted polarity *and* it takes a
  shell command rather than an expression *and* it runs **before** the step, so it
  cannot see prior status. This kills the `if: failure()` cleanup idiom outright.
- **Workflow names cannot contain spaces** (`^[a-z0-9][a-z0-9._-]*$`), so
  `name: Build and Test` must be slugged — constrains
  [Generated code shape](008-generated-code-shape.md).
- `github.sha`/`ref`/`repository`/`run_id`/`job` are translatable via `$MILLWRIGHT_*`,
  set on every job container in cloud and local — but these are **control-plane
  internals, not public API**. Whether the importer may depend on them is left as a
  decision for [Expression and conditional translation](004-expression-translation.md).
- **Composite actions**: the schema yields a decidable predicate (`using: composite` ∧
  all steps `run:`-or-curated ∧ no `outputs`), so the map's fog item resolves toward
  "inline while the predicate holds" rather than a fixed depth. Composite `outputs` are
  the most common reason one will not inline. Usage *frequency* is a corpus question
  desk research cannot answer.

Routed downstream: holes cluster around **three root absences**, so
[Hole rendering and the import report](005-hole-rendering-and-report.md) should group
by root cause rather than per line; and "translate" leans heavily on generated shell,
which sets expectations for [Generated code shape](008-generated-code-shape.md).

Surfaced [Behavior-drift contract](012-behavior-drift-contract.md).
