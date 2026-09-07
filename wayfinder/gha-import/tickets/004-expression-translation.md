---
id: "004"
title: Expression and conditional translation
type: wayfinder:grilling
status: open
assignee: none
blocked-by: ["001"]
---

## Question

What is the exact closed vocabulary of `${{ }}` expressions the importer translates,
and how does GHA `if:` become millwright's `skipIf`?

Charting fixed the posture (Note 5): a closed list, no transpiler, job-level `if:` is a
hole. This ticket pins the list and the mechanics.

**The translatable vocabulary** — confirm and complete:

| GHA | millwright |
|---|---|
| `github.sha`, `github.ref`, `github.repository`, … | `$MILLWRIGHT_*` context vars |
| `secrets.FOO` | `secrets: { FOO: Secret.named('foo') }` + `$FOO` |
| `env.FOO` | a TS constant interpolated into the step string |
| `matrix.x` | the TS loop variable |
| `inputs.x` | `steps: (inputs) => [...]` |
| `hashFiles(...)` | `hashFiles(...)` in `Cache.keyed` |
| `vars.X` | a TS constant with a **placeholder** value + report line |

**The `MILLWRIGHT_*` roster is itself unpinned.** §14 says context vars are synthesized
from the checkout but never enumerates them; the importer forces the question. Read the
shipped step shim / local runner for the real list, and record any `github.*` context
field with no counterpart as a finding for ticket 010.

**Step-level `if:`** → `skipIf`, which is an **exit-0 shell guard**, so the polarity
inverts: `if: <cond>` becomes `skipIf: '<shell test that succeeds when cond is FALSE>'`.
Decide which comparison shapes translate (`==`, `!=`, `contains()`, `startsWith()`
against a context var) and confirm the inversion is correct against the shipped
`Step.run` semantics — getting polarity backwards silently runs steps that should be
skipped, the worst possible failure mode here.

**Job-level `if:`** — a hole with an explanation (Note 5). Decide the explanation's
content: does the report *recommend* the specific workflow-split (naming the trigger
the condition implies), or just state that it can't be translated?

**Status functions** (`always()`, `failure()`, `success()`, `cancelled()`) — no target;
v1 ruled out soft-fail. Confirm these are holes and decide whether an `if: always()`
cleanup step gets a special-cased message, since it's a very common idiom.

**`$GITHUB_ENV` / `$GITHUB_OUTPUT`** — steps passing values to later steps via these
files. millwright steps are separate shell invocations with no such channel. Decide
the disposition (likely hole; possibly a finding for ticket 010).

Also: `vars.*` values are **not in the YAML** — decide placeholder-only versus an
opt-in `--fetch-vars` flag using the deployment's GitHub App, noting that a migration
tool hard-depending on GitHub's API is a poor advertisement for millwright's thesis.
