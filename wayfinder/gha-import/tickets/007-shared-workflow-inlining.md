---
id: "007"
title: Shared-workflow inlining
type: wayfinder:grilling
status: open
assignee: none
blocked-by: ["002"]
---

## Question

How does the importer resolve and inline a shared workflow, and what does the consumer's
generated file look like afterward?

Charting fixed the posture (Note 4): inline into each consumer, degrading to report-only
when the YAML isn't reachable, with deduplication into an npm construct package left as
a human follow-up. This ticket pins resolution, inlining mechanics, and the handoff.

**Resolution.** `uses: org/repo/.github/workflows/ci.yml@v1` names a repo, a path, and a
ref the importer must fetch.

- Where does the YAML come from — a local path the user points at, a git clone at the
  pinned ref, or the GitHub API? Note the map's preference for not hard-depending on
  GitHub's API.
- `@v1` may be a tag, branch, or SHA. Pinning matters: inlining a *moving* ref captures
  a snapshot, and the report should say which commit was captured.
- Transitive shared workflows (a shared workflow that itself `uses:` another) — inline
  recursively, or stop at depth 1?

**Parameter binding.** `workflow_call` workflows take `inputs:` and `secrets:`, passed
by the caller via `with:` / `secrets:`. Inlining must substitute them:

- `inputs.x` inside the shared workflow → the caller's literal `with:` value, or a TS
  constant at the top of the generated file? A named constant preserves the *intent*
  and makes the later refactor into a shared construct obvious.
- `secrets: inherit` — the caller passes everything. millwright requires **explicit
  per-job secret declaration**, so `inherit` cannot be translated faithfully; the
  importer must enumerate which secrets the shared workflow actually references.
- Input `default:` values when the caller omits them.

**Naming and collisions.** The shared workflow's job names land in the consumer's
namespace, where names are check-run contexts and collision is a synth error. Decide
prefixing, and whether prefixing breaks required-check config on the GitHub side (it
will — the report should say so).

**The handoff.** Note 4 says deduplication is a human follow-up. Decide how strongly
the generated code signals it:

- A clearly-marked region (`// --- inlined from org/repo@sha ---`) that reads as a
  seam, so the later extraction into `@org/millwright-workflows` is mechanical?
- Does the report name the platform repo and state the recommended ordering — port it
  to a construct package, then re-import consumers?

**Also in scope**: in-repo `./.github/actions/*` composite actions are the same problem
at a smaller scale and are currently map fog. If ticket 001's inventory shows they're
common, decide here whether they graduate into this ticket or a new one.
