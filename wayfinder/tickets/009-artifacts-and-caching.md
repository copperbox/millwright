---
id: "009"
title: Artifacts and caching
type: wayfinder:grilling
status: open
assignee: none
blocked-by: ["001"]
---

## Question

How do jobs persist and restore caches (dependencies, docker layers) and pass artifacts
between jobs in a run and across runs — S3 layout, cache keys, retention/eviction, and
how this composes with whatever caching the chosen compute service provides natively?
Blocked on [Job compute runtime](001-job-compute-runtime.md).
