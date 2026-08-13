---
id: "002"
title: Action mapping table
type: wayfinder:research
status: open
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
