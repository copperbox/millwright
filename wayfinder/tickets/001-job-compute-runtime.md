---
id: "001"
title: Job compute runtime
type: wayfinder:research
status: closed
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

## Resolution

**CodeBuild on-demand EC2 compute (ARM `arm1.*` default, x86 opt-in) is the single v1
job runtime.** Tier later *inside* CodeBuild via `computeTypeOverride` to Lambda compute
for small fast jobs; no raw-Lambda tier; no Fargate in v1. Full findings:
`research/job-compute-runtime.md` on branch `research/job-compute-runtime` (us-east-1
pricing verified 2026-08-06, primary-source cited).

- CodeBuild is the only candidate with both **zero idle cost and first-class
  docker-in-docker** (privileged mode). Fargate is 3–5x cheaper on raw compute (and the
  only Spot option) but cannot `docker build` — kaniko, AWS's documented workaround, is
  archived — has zero native caching, and fresh accounts get a 6-vCPU Fargate quota
  (~3 concurrent jobs). Raw Lambda can't run arbitrary job images at all; AWS already
  productized the viable subset as CodeBuild Lambda compute mode.
- **Cost at mid workload** (100 runs/day x 5 min): ~$51/mo on arm1.small ($10–$204/mo
  across the 50x2min → 200x10min range). CodeBuild reserved capacity (~$89/mo/instance)
  exceeds the whole on-demand bill — violates zero-idle for no gain; skip it.
- **`StartBuild` replaces most runner plumbing**: per-run overrides for source commit,
  inline buildspec, image, env, privileged mode, timeouts; built-in queueing
  (`QUEUED` phase + `queuedTimeoutInMinutes` 5–480) means no scheduler queue in v1;
  live CloudWatch log streaming; results via `BatchGetBuilds` or EventBridge
  build-state events; 36 h max build duration.
- **Open risk**: on-demand provisioning latency is officially unquantified — measure the
  `PROVISIONING` phase before setting time-to-first-log expectations (spun out as
  [CodeBuild provisioning-latency spike](012-codebuild-provisioning-latency-spike.md)).
  Provisioning is billed, and per-build minute rounding adds +5–15% at these job lengths.

**Constraints radiated to other tickets**: orchestration = one `StartBuild` per job,
consuming EventBridge build-state events (fits the polling resolution's on-change-only
Step Functions rule). Caching should design around CodeBuild S3 cache mode, with local
docker-layer cache as opportunistic. Secrets ride buildspec-native Secrets Manager/SSM
injection — but log masking is exact-match-only (transformed values leak; worth a
definition-schema lint).
