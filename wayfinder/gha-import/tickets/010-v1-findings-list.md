---
id: "010"
title: v1 findings list
type: wayfinder:task
status: open
assignee: none
blocked-by: ["003", "004", "006", "007"]
---

## Question

Assemble the gaps this map exposed in shipped millwright v1, as a findings document fed
back to the platform — **without** deciding any of them here.

Note 6 rules v1 API extensions out of scope: the importer translates into the shipped
API only, and letting a disposable codegen tool drive permanent API design lets
GitHub's accidents shape millwright's surface. But the importer is an excellent
stress test — translating real-world GHA workflows finds real holes, and those findings
are worth capturing while they're fresh.

**Start from the research assets** — both closed research tickets collected far more
than charting anticipated: branch `research/gha-feature-inventory` (twelve
structural impossibilities beyond the known list) and branch `research/gha-action-mapping`
(§7 collects twelve cross-cutting candidates, including the plumbing oddity that
`Step.run` has no `name` while `RunModelStep` carries one and the buildspec already
renders `--name`). Notable additions to the list below: **no step identity or step
outputs** (`$GITHUB_OUTPUT` — intra-job flow), **no cross-step env** (`$GITHUB_ENV`),
**no service containers**, **no deployment environments / approval gates**, **no
job-level concurrency**, **no trigger filtering of any kind**, **`ManualInput` is
choice-or-boolean only** while `type: string` is GHA's default, **cron is UTC-only**,
**multi-path artifacts are a definition-API-only gap** (`ArtifactModel.paths` and the
shim already support them), and **`AWS_` being a reserved env prefix** makes
`aws-region` unsettable by any means.

Known before this ticket starts (confirm, sharpen, and add to):

- **No non-secret config surface.** `JobProps` is
  `steps / compute / privileged / timeout / secrets / produces / consumes / dependsOn / cache`
  — there is no `env`. GHA `env:` blocks and `vars.*` have no runtime target; charting's
  answer was TS constants, which fails for operator-owned values that must change
  **without a commit**. A `Config.named()` → SSM **plain String** (free tier, no CMK,
  no masking, no per-job KMS grants) construct is the obvious shape. Decided on its own
  merits, elsewhere.
- **No job outputs.** `needs.x.outputs.y` has no target; the closest honest translation
  is a small artifact file, which changes the job's shape.
- **No second-repo source access.** v1 §11.2: *"Jobs never clone; they pull
  `source.tar.gz` from the run prefix"* — jobs hold no git credential.
  `actions/checkout` with `repository:` (sibling repos, tools repos, test fixtures) has
  nowhere to land.
- **The `MILLWRIGHT_*` context roster is unenumerated.** §14 says context vars are
  synthesized from the checkout but never lists them; ticket 004 pins the real roster
  from the shipped shim. Any `github.*` field with no counterpart is a finding.
- **No path filters on triggers** (ticket 003), **no `$GITHUB_ENV`/`$GITHUB_OUTPUT`
  step-to-step channel** (ticket 004), and the **fail-fast** behavior change every
  imported matrix incurs (ticket 006).

For each finding record: what GHA construct exposed it, how common it is (ticket 001's
inventory), what the importer does today instead, and a sketch of the shape a millwright
answer might take. **No decisions** — this is a handoff.

Deliverable: a findings document in the repo, linked from this ticket, and a one-line
note on the map. Whether it becomes a new wayfinder map is not this ticket's call.
