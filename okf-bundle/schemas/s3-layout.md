---
type: schema
title: S3 layout — artifacts and caches
tags:
  - millwright
  - s3
  - schema
  - security
timestamp: 2026-08-12T21:26:44.383Z
---

```
runs/<repo>/<workflow>/<number>/
    in/                          control-plane inputs — synth role writes; job roles read-only
        model.json
        source.tar.gz
    out/<job>/<artifact-name>/…  each job role writes ONLY its own out/<job>/ subtree
cache/<repo>/<key>               keyed dependency-cache objects (repo-scoped trust)
```

## The `in/` / `out/` split is a privilege split

- `in/` is written by the **synth role** only, and read-only to job roles. It carries the two things
  the control plane produced: the validated [run model](run-model.md) and the packaged source.
- `out/<job>/` is writable by exactly one job role. **Poisoning is confined to a job's own declared
  outputs — which is just "producing artifacts."**

**Jobs never clone.** They pull `source.tar.gz` from `in/`, which is why user jobs need no
deploy-key access at all.

## Rerun

`runs rerun --failed` prefix-copies succeeded jobs' `out/<job>/` subtrees into the new run's prefix.
This is done by the **launcher** (which holds the S3 copy grants), not the decider.

## Caching

GHA-style keyed semantics (`hashFiles`, `paths`, `restoreKeys`); an exact hit skips the save;
eviction is by lifecycle rule. **Write trust is repo-scoped**: exact-key write scoping was illusory
because any branch can compute the shared key legitimately.

Docker layer caching is **outside** the keyed system in v1 — buildx with an ECR/S3 backend is a
job-level technique; a `DockerCache` construct is deferred.

## Notes

- Retention is via **lifecycle rules** per the `retention` prop.
- **CodeBuild's native artifacts and S3 cache modes are unused** — deliberately, so the layout above
  is the only contract.

Code: `packages/millwright-state/src/s3-layout.ts`.

# Citations

[1] [Spec §9.3, §12](../../docs/specs/1-millwright-v1-implementable-specification.md)
