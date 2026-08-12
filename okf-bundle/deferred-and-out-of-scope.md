---
type: decision
title: Deferred and out of scope for v1
tags:
  - millwright
  - v1
  - scope
timestamp: 2026-08-12T21:28:37.833Z
---

Recorded so these are not re-proposed as oversights. **Deferred** means "considered, not now";
**out of scope** means "deliberately never, in this product".

## Deferred

- **fail-fast** job cancellation on first failure
- **GitHub Actions YAML importer**
- **notifications and badges** (this is why the construct has no notification-target props)
- **run web UI**
- **`SecretFile`** — file-shaped secrets are v1'd by a step writing the env var to disk
- **`DockerCache`** — docker layer caching is a job-level buildx technique in v1
- **opportunistic webhook fast-path** — would also carry check-run re-run buttons, since requested
  actions are webhook-delivered. Would be an accelerator over the polling core, never a dependency.
  See [Why polling](decisions/no-webhooks.md).
- **check-run annotations** (file/line)
- **concurrency extensions**: numeric limits, full FIFO, a `reject` policy, a dispatch bypass flag
- **tier-1 observation of `refs/pull/*`** via `ref-prefix`
- **durable installation-token cache** — pre-approved shape is a CMK-encrypted blob in the *polling*
  table with item TTL = token expiry
- **schedule sharding past N≈100 repos**
- **connection reuse across poll ticks**
- **per-run role layering** for jobs that ever need cross-run isolation — note this is the sanctioned
  path, *not* a return to [per-run roles everywhere](decisions/stable-job-roles.md)

## Out of scope

- **multi-tenancy / millwright-as-a-service** — single-tenant is a framing invariant
- **code hosting and PR/review UX** — GitHub stays the source of truth
- **webhook-*dependent* triggering**
- **soft-fail / allow-failure jobs**

# Citations

[1] [Spec §19](../docs/specs/1-millwright-v1-implementable-specification.md)
