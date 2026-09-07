---
id: "005"
title: Hole rendering and the import report
type: wayfinder:grilling
status: open
assignee: none
blocked-by: ["001", "012"]
---

## Question

What exactly does a hole look like — in the generated file, and in the console?

Charting fixed the policy (Note 2): always-valid output, unmappable constructs become
loud runtime failures at the exact step position, plus a console report that is the
primary signal. This ticket pins all three surfaces.

**In the generated file.** A hole must compile and synth, and must fail loudly if
reached. Decide the rendered form — likely a `Step.run` whose shell echoes the original
YAML fragment and exits non-zero — and settle:

- Does it carry the **original YAML** verbatim in the message, so the user sees what
  they must reimplement without opening the old file?
- Step **naming**: job names are check-run contexts (v1 §13.2) and collide-checked; do
  hole steps get a recognizable marker?
- What about holes that aren't step-shaped — an untranslatable `on:` filter, a job-level
  `if:`, a `workflow_call` input? There is no step to fail at. Decide where those go
  (comment + report only, or a guard step injected at the top of the job).
- The accompanying `// TODO(millwright): …` comment format — stable enough to grep for.

**In the console.** The report is what the user actually acts on. Decide:

- Grouping (by workflow / by job / by feature kind), and ordering.
- Whether it reports **coverage** (N of M steps translated) as well as holes — a
  progress signal for a fleet migration.
- Whether *deletions* are reported as loudly as holes. `actions/checkout` and
  `configure-aws-credentials` vanish silently by design, and a user who doesn't know
  that will think the importer dropped their steps. This is a trust question.
- **Exit code**: non-zero when holes exist. But then a partially-translated repo fails
  CI-style checks — is that right, or does it need `--allow-holes`? Note the file is
  still written either way (Note 2's whole point).

**Machine-readable output** — decide whether a `--json` report exists now or is
deferred. It is the seam a fleet-scale aggregate report would need (map fog).

Distinguish clearly between a **hole** (the importer chose not to translate) and an
**importer bug** (self-verification failed, ticket 009) — they must never look alike.
