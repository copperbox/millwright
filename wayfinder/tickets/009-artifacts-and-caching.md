---
id: "009"
title: Artifacts and caching
type: wayfinder:grilling
status: closed
assignee: dan
blocked-by: ["001"]
---

## Question

How do jobs persist and restore caches (dependencies, docker layers) and pass artifacts
between jobs in a run and across runs — S3 layout, cache keys, retention/eviction, and
how this composes with whatever caching the chosen compute service provides natively?
Blocked on [Job compute runtime](001-job-compute-runtime.md).

## Resolution

Decided live with Dan (2026-08-06):

- **Artifacts**: millwright-owned S3 bucket with run-scoped layout
  (`<repo>/<run-id>/<job>/<name>`). Jobs declare `produces` / `consumes` in the
  workflow definition; synth generates upload/download buildspec steps and grants each
  job role access to only its run's prefix (same least-privilege pattern as
  [secrets](008-secrets-injection.md)). Synth-time check: every `consumes` must match a
  `produces` — no GHA-style runtime string matching. Retention via configurable S3
  lifecycle rules. CodeBuild's native artifacts config is not used.
- **Dependency caching**: millwright-keyed, GHA-style semantics —
  `cache: { key: hashFiles('package-lock.json'), paths, restoreKeys }` in the
  definition; synth emits restore/save steps against S3 objects named by key
  (exact-hit skips save; restore-keys prefix fallback; lifecycle eviction for cold
  entries). CodeBuild's native S3 cache mode is skipped entirely — one unkeyed cache
  per project invites branch poisoning and silent staleness.
- **Docker layer caching**: out of the keyed system in v1. Local layer cache is
  opportunistic-only on ephemeral hosts; buildx with an ECR/S3 cache backend is a
  job-level technique users apply in their own steps. A first-class `DockerCache`
  construct goes to fog.

**Constraints radiated**: `produces`/`consumes` doubles as job-DAG information for the
[Workflow-definition construct API](004-workflow-definition-api.md). The local runner
mirrors the artifact layout on the local filesystem and can no-op or local-dir the
cache ([Local execution parity](007-local-execution-parity.md)).
