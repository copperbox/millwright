---
id: "001"
title: Job compute runtime
type: wayfinder:research
status: open
assignee: research-subagent
blocked-by: []
---

## Question

Which AWS compute service(s) should run millwright jobs? Compare **CodeBuild**,
**ECS Fargate**, and **Lambda** (including a possible tiered model: small jobs on
Lambda, container jobs elsewhere) across:

- Container support: running arbitrary job images, and *building* docker images inside a
  job (docker-in-docker / kaniko / buildkit story per service).
- Startup latency from "trigger fired" to "job process running".
- Cost per build-minute at small-team CI volume (e.g. 50–200 runs/day, 2–10 min each),
  including any idle/floor costs; spot/preemptible options.
- Caching: docker layer cache, dependency cache — what each service offers natively.
- Concurrency and account quotas; max job duration.
- Log integration (streaming to CloudWatch, tailing mid-run).
- Fit with the "as serverless as possible, zero idle cost" constraint.

Deliver a recommendation with a rough cost model. Findings on branch
`research/job-compute-runtime`.
