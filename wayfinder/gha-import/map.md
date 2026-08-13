---
labels: [wayfinder:map]
---

# GHA import — wayfinder map

## Destination

An **implementable spec for `millwright import`**: a one-shot, disposable codegen that
reads `.github/workflows/*.yml` and emits a `millwright/workflows.ts` the user owns,
reviews, and outgrows. The map is done when translation coverage, the unmappable-feature
policy, generated-code shape, and the CLI surface are all locked, and the spec is
**committed as `spec/millwright-import.md`** *and* **published to the
[AI Spec Council](https://github.com/copperbox/millwright/discussions) discussions
category** (mirroring the v1 spec's Discussion #1) with no open questions.

This map graduates the **GHA YAML importer** fog item from the
[millwright v1 map](../map.md), whose destination has been reached.

## Notes

**Framing settled while charting** (these bound every ticket):

1. **Disposable migration aid, never a compatibility layer.** The importer generates
   code you own and then never run again. No YAML at runtime, no marketplace action
   runtime, no fidelity promise. A living translator would make GHA semantics a
   permanent compatibility surface and contradicts workflows-as-code, branch-testable
   synth, and local execution parity.
2. **Always-valid output.** The importer never emits code that fails to compile or
   synth. Unmappable constructs become **loud runtime failures at the exact step
   position** (never silently dropped), plus a **console report** printed by the CLI.
   TODO comments stay in the file but are never the primary signal — comments get
   skimmed past. Rationale: a file that compiles can be run locally immediately, so
   the migration loop is run → fail at the untranslated step → fix → repeat.
3. **Curated, hardcoded `uses:` table.** A deliberately small set, no extensibility
   (a user-supplied mapping registry is a permanent fixture, and this tool is
   disposable). Several entries map to millwright *concepts*, not steps:
   - `actions/checkout` → **deleted** (source is already in the build; §11.2 jobs
     never clone)
   - `aws-actions/configure-aws-credentials` → **deleted** (the synthesized job role
     *is* the credential; the OIDC dance evaporates)
   - `actions/setup-*` → not a step; sets `image:` (image-is-the-toolchain, v1
     ticket 013)
   - `actions/cache` → `Cache.keyed({ key, paths, restoreKeys })`
   - `actions/upload-artifact` / `download-artifact` → `produces` / `consumes` —
     **the primary signal for reconstructing the job DAG**
4. **Shared workflows are inlined.** `uses: org/repo/.github/workflows/x.yml@ref` is
   read and translated inline into each consumer, degrading to report-only when the
   YAML isn't reachable. Deduplication into npm construct packages (v1 §4.2's sharing
   answer) is a human follow-up — the alternative hands you a non-working repo and a
   multi-repo refactor as a prerequisite.
5. **Closed expression vocabulary, no transpiler.** A fixed translatable list; every
   other `${{ }}` is a hole. **Job-level `if:` is a hole with an explanation**, never
   an automatic restructure — synth is trigger-independent, so `if: github.ref == ...`
   is not a condition in millwright but a *different workflow with a different
   trigger*, and that's a pipeline-design judgment call.
6. **The v1 API is fixed.** This map translates into the shipped API only. Gaps the
   importer exposes become a **findings list** (ticket 010), never API changes here —
   letting a disposable codegen tool drive permanent API design lets GitHub's accidents
   shape millwright's surface.
7. **Self-verifying, ships in the CLI.** Generate → typecheck → shipped `synthesize()`
   → `validateRunModel()` → only then write. A failed self-check is an importer bug.
   This verifies output is **well-formed, not faithful** — semantic fidelity is human
   review. Ships as `millwright import` in `@copperbox/millwright-cli`.
8. **No unresolved fog at the terminus.** Every **Not yet specified** item must either
   graduate to a ticket and be decided, or be explicitly ruled **Out of scope**, before
   [Assemble the import spec](tickets/011-assemble-import-spec.md) may close. The fog
   section must be empty at the destination.

**Grounding**: v1 is **built**, not merely specced — four packages at v0.6.0. The
translation target is the shipped API of `@copperbox/millwright-workflows`
(`WorkflowSet`, `Workflow`, `Job`, `Trigger.*`, `Secret`, `Artifact`, `Cache`,
`Compute`, `Step`, `hashFiles`, `synthesize`, `validateRunModel`), not `spec/millwright-v1.md`
§4. Where the two disagree, the code wins.

**Working the map**: tracker conventions are in [TRACKER.md](../TRACKER.md). Use the
`/grilling` skill for grilling tickets and `/research` for research tickets.

## Decisions so far

<!-- one line per closed ticket: gist + link -->

- [GHA feature inventory](tickets/001-gha-feature-inventory.md) — whole-schema
  disposition table: **~30 translate, ~45 hole, ~14 drop**, grounded on five shipped-code
  facts (`StepModel` is `{ run, skipIf? }`; no env concept anywhere; no expression
  evaluator; no job outputs or conditions; steps share no shell state). All five
  predicted structural impossibilities confirmed, **twelve more found** — step
  identity/`$GITHUB_OUTPUT`, `$GITHUB_ENV`, `services:`, deployment `environment:` (can
  silently remove a **production approval gate**), job-level `concurrency`, *all* trigger
  filtering (`Trigger.pullRequest()` takes no arguments), free-text dispatch inputs, cron
  `timezone:`, the event surface beyond `TriggerKind`'s 5, matrix scheduling, non-Linux
  runners, container tuning. Corrections: **matrix is not a hole** (static matrices
  unroll at codegen); `skipIf` is not a drop-in for step `if:` (inverted, shell-not-
  expression, runs *before* the step, so `if: failure()` is dead); workflow names cannot
  contain spaces. Asset: branch `research/gha-feature-inventory`. Spawned
  [Behavior-drift contract](tickets/012-behavior-drift-contract.md).
- [Action mapping table](tickets/002-action-mapping-table.md) — per-action targets
  against real shipped signatures. `checkout` → deleted, **but `source.tar.gz` carries no
  repository at all** (`.git` excluded), so even default `fetch-depth: 1` is unreproduced
  and the rule becomes *delete, then scan `run:` steps for git*; `configure-aws-credentials`
  → deleted, but `aws-region` **cannot be set at all** (`AWS_` is a reserved prefix, no
  cross-step env) — a cross-region parity break; `setup-*` → `image`, with its `cache:`
  sub-input **untranslatable** (every default cache dir is outside the workspace);
  `cache` → `Cache.keyed` (key becomes an array of fragments, may not contain `/`, **one
  cache per job**); `upload-artifact` → `produces` (**`if-no-files-found: warn` becomes a
  job failure**); `download-artifact` → `consumes`, which takes an **`ArtifactRef`, not a
  name**, forcing topologically-ordered, variable-bound job emission. Asset: branch
  `research/gha-action-mapping`. Spawned
  [Behavior-drift contract](tickets/012-behavior-drift-contract.md).

## Not yet specified

<!-- Per Note 8, every item here must be cleared before the spec is assembled. -->

- **Composite action translation depth** — in-repo `./.github/actions/*` composite
  actions are visible to the importer (unlike marketplace actions) and could be inlined
  as steps. **Sharpened by [GHA feature inventory](tickets/001-gha-feature-inventory.md)**:
  the schema yields a decidable predicate (`using: composite` ∧ all steps `run:`-or-
  curated ∧ no `outputs`), so the answer trends toward *inline while the predicate holds*
  rather than a fixed depth — composite `outputs` being the usual reason one won't
  inline. Still fog because usage *frequency* is a corpus question desk research can't
  answer. [Shared-workflow inlining](tickets/007-shared-workflow-inlining.md) owns the
  call on whether this graduates into that ticket or its own.
- **Re-import and drift** — "one-shot" is the intent, but reality is import → edit →
  upstream YAML changes. Whether the importer detects drift, supports a second pass,
  or refuses on an existing `millwright/workflows.ts` is undecided. Interacts with
  [Generated code shape](tickets/008-generated-code-shape.md)'s overwrite policy.
- **Fleet migration playbook** — the human-facing guide for migrating N repos: the
  platform-repo-first ordering, when to factor inlined shared workflows back into an
  npm construct package, how to run old and new CI in parallel during cutover.
  Documentation, not codegen — may be out of scope.
- **Fleet-scale aggregate reporting** — importing many repos at once and getting one
  consolidated coverage/holes report, rather than per-repo console output. Sharpens
  once [Hole rendering and the import report](tickets/005-hole-rendering-and-report.md)
  fixes the single-repo report shape.

## Out of scope

- **Living translator / runtime YAML execution** — YAML as an ongoing source of truth
  makes GHA semantics a permanent compatibility surface (expressions, marketplace
  actions, GitHub-hosted runtime) and contradicts three v1 commitments. Settled in
  charting.
- **Extensible mapping registry** — user-supplied `uses:` mappings. Nobody should
  maintain config for a program they run once.
- **Expression transpiler** — parsing GHA's full expression grammar. A permanent
  artifact in service of a disposable tool.
- **v1 definition-API extensions** — a non-secret `Config`/`Var` construct, job outputs
  (`needs.x.outputs.y`), second-repo source access. Real gaps, but they must be decided
  on millwright's own merits, not as importer implementation details. Recorded as
  findings by ticket 010 for a future effort.
- **Marketplace action runtime** — executing `actions/*` JavaScript or Docker actions.
  Requires reimplementing GitHub's runner.
- **Differential execution testing** — proving a translated workflow behaves
  identically by running both against real Actions. Semantic fidelity is human review.
