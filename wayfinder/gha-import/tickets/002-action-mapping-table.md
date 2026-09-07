---
id: "002"
title: Action mapping table
type: wayfinder:research
status: closed
assignee: research-subagent
blocked-by: []
---

## Question

For each action in the curated mapping table (Note 3), what are its **exact inputs and
semantics**, and what does a faithful translation into the shipped millwright API
actually require?

The set is fixed by charting and deliberately small — this ticket does not expand it,
it makes each entry precise enough to implement:

- **`actions/checkout`** — deleted. But enumerate the inputs that make deletion *wrong*:
  `repository:` (another repo — a v1 gap, feeds ticket 010), `submodules:`,
  `fetch-depth:` (shallow vs full history — does the run's `source.tar.gz` carry
  history at all?), `ref:`, `path:`, `lfs:`, `token:`. Each needs a disposition.
- **`aws-actions/configure-aws-credentials`** — deleted, the job role is the credential.
  Confirm which inputs signal a case where deletion is wrong (`role-to-assume` naming a
  *different* role, `aws-region` where steps then read `$AWS_REGION`).
- **`actions/setup-node` / `setup-python` / `setup-go` / `setup-java`** — collapse into
  `image:`. Determine the version-input → image-tag mapping for each
  (`node-version: 22` → `public.ecr.aws/docker/library/node:22`), what happens with
  version ranges / `.nvmrc` / `lts/*`, and what the `cache: npm` sub-input should do
  (it is `actions/cache` in disguise). **Two `setup-*` in one job has no single
  official image** — record it as a hole with a suggested remedy.
- **`actions/cache`** (and `cache/restore`, `cache/save`) — map `key`, `path`,
  `restore-keys` onto `Cache.keyed`. Note the arity difference: GHA `path` is
  multi-line, and `key` embeds `${{ hashFiles(...) }}` which has a direct
  `hashFiles()` target in the shipped API. Check `Cache.keyed`'s real signature in
  `packages/millwright-workflows/src/values.ts`.
- **`actions/upload-artifact` / `actions/download-artifact`** — map onto
  `produces` / `consumes`. This is the load-bearing pair: it reconstructs the job DAG
  (ticket 006). Record `name:`, `path:` (globs? multi-path?), `if-no-files-found:`,
  `retention-days:`, and download's *nameless* form (downloads **all** artifacts — which
  has no `consumes` equivalent and is likely a hole).

For each: the action's input schema, the millwright target with the **real** shipped
signature, and every input that has no target.

Deliverable: a per-action mapping table on a `research/gha-action-mapping` branch,
linked from this ticket.

## Resolution

Per-action mapping table with real shipped signatures. Asset on branch
`research/gha-action-mapping`, `research/gha-action-mapping.md`. Schemas read at today's current
majors, which are well ahead of what repos typically pin (checkout v7, cache v6,
upload-artifact v7, download-artifact v8, setup-* v5–v7) — the importer must handle
*pinned old* versions, not just current ones.

**Nine shipped-runtime facts decide most dispositions**: no job `env` at all, and
`RESERVED_ENV_PREFIXES = ['MILLWRIGHT_','CODEBUILD_','AWS_']` are **silently dropped**;
each step is its own `/bin/sh -c`; **`.git` is excluded from `source.tar.gz`**
(`--depth 1` fetch, `tar --exclude=.git`); artifact/cache paths are workspace-relative
literals with **no globs and no `~`**; artifact names must be single path segments;
a missing artifact path **throws**; consumed artifacts land at their original path;
`cache?: Cache` is **singular**; `image` is required.

**Per action:**
- **`checkout`** → deleted, but the sharpest finding on the map so far: `source.tar.gz`
  carries **no repository at all**, so not merely `fetch-depth: 0` but the *default*
  `fetch-depth: 1` is unreproduced — `git rev-parse` fails in a translated job. The
  correct rule is *delete, then separately scan `run:` steps for git invocations*.
  `repository:` is a ticket-010 gap; `submodules`/`lfs`/`path`/`ref` are holes.
- **`configure-aws-credentials`** → deleted; both charting-flagged cases confirmed.
  `aws-region` is worse than expected: it **cannot be set at all** — not via `secrets:`
  (the `AWS_` prefix is reserved) and not by a preceding step (no cross-step env).
  Cloud inherits CodeBuild's own `AWS_REGION` (wrong for cross-region workflows); local
  `docker run` may have none — a **parity break**. `inline-session-policy` /
  `managed-session-policies` are permission-*reducing* and so security-relevant holes.
- **`setup-*`** → `image:`. Exact versions and `x`-ranges map; semver ranges, `lts/*`,
  `latest`, `nightly`, `check-latest` do not. setup-java's `distribution` picks the
  *image*, not the tag. **The `cache:` sub-input cannot be translated at all** — every
  default cache dir (`~/.npm`, pip cache, `GOMODCACHE`, `~/.m2`, `~/.gradle`) is outside
  the workspace and fails `assertWorkspaceRelative`. setup-go's `cache` defaults to
  **true**. Two `setup-*` in one job: hole, three ranked remedies, plus the trap that
  "last wins" is the wrong resolution.
- **`cache`** → `Cache.keyed`. `hashFiles()` is a clean direct target. The key splits
  from one interpolated string into an **array of fragments**, and may not contain `/`
  — so `${{ github.ref }}` in a key is invalid. **One cache per job.** `restore`-alone
  gains an unrequested save; `save`-alone gains an unrequested **restore** that
  materializes files before any step runs.
- **`upload-artifact`** → `produces`. **`if-no-files-found`'s GHA default `warn`
  becomes a job failure** — the highest-risk silent behavior change found.
  `include-hidden-files` also inverts. Multi-path is a **definition-API-only** gap:
  `ArtifactModel.paths` and the shim already support many.
- **`download-artifact`** → `consumes`, which takes an **`ArtifactRef`, not a name** —
  so generated jobs must be topologically ordered and each bound to a variable, a hard
  constraint on [Generated code shape](008-generated-code-shape.md). **`path:` has no
  target.** Nameless form is a hole for three independent reasons. Cross-run/cross-repo
  download is structurally impossible.

§7 of the asset collects twelve cross-cutting ticket-010 candidates, including one pure
plumbing oddity: `Step.run` has no `name`, yet `RunModelStep` carries one and the
buildspec already renders `--name`.

Surfaced [Behavior-drift contract](012-behavior-drift-contract.md).
