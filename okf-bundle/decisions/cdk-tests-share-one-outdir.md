---
type: decision
title: CDK construct tests share one cloud-assembly outdir
description: Why construct tests build their App with test/support/test-app.ts
  instead of new App(), and why vitest's timeout is 30 s.
tags:
  - millwright
  - testing
  - cdk
timestamp: 2026-09-08T03:23:12.874Z
---

Every `Template.fromStack(...)` over the `Millwright` construct synthesizes a full stack, and that
stack bundles **ten `NodejsFunction` Lambdas with esbuild** (poller, launcher, sweep, three synth-job
functions, two run-executor functions, reporter, step-events writer) plus the synth tooling bundle
from `millwright-cli`. One synth costs roughly 1.5 s on a fast workstation and 5–11 s on a loaded
GitHub Actions runner — past vitest's 5 s default per-test budget. That is what made the first CI
workflow run (PR #36) fail with timeouts in `data-stores`, `millwright` and `run-executor-construct`.

## What was decided

- Construct tests build their App with `testApp()` from `packages/millwright-cdk/test/support/test-app.ts`,
  never a bare `new App()`. The helper pins one cloud-assembly outdir per worker process.
- The root `vitest.config.ts` sets `testTimeout: 30_000`.

## Why the shared outdir works

`aws-cdk-lib`'s `AssetStaging` keeps a **process-wide cache** keyed on (outdir, source path, bundling
options). A bare `new App()` picks a fresh temp outdir every time, so the cache never hits and every
test in a file re-runs all the esbuild bundles. With one outdir per process the first synth in a file
bundles and every later synth reuses it: `data-stores.test.ts` dropped from ~21 s to ~4.5 s locally.

The outdir must be **per process**, not shared across vitest workers: each App writes
`manifest.json` and `Test.template.json` into it, and concurrent workers would race on those files.

## Why not `CDK_OUTDIR`

Setting the env var would reach every `new App()` without touching tests, but `App` treats a set
`CDK_OUTDIR` as a request for `autoSynth`, registering a `beforeExit` listener per App. Hundreds of
Apps per run means listener-leak warnings and exit-time synths of half-built trees from the
"throws at construct time" tests.

## Why not disable bundling

The `aws:cdk:bundling-stacks` context can skip bundling entirely, but the tests would then stop
exercising the real bundling configuration (workspace aliases, entry points, formats).

## Citations

[1] [test-app.ts](../../packages/millwright-cdk/test/support/test-app.ts)
[2] [vitest.config.ts](../../vitest.config.ts)
