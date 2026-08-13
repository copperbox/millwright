---
id: "001"
title: GHA feature inventory
type: wayfinder:research
status: open
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
