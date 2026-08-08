---
id: "012"
title: CodeBuild provisioning-latency spike
type: wayfinder:task
status: closed
assignee: dan
blocked-by: []
---

## Question

CodeBuild on-demand provisioning latency is officially unquantified anywhere, and it
sets millwright's "trigger fired → first log line" UX floor (stacking on the ~30–90 s
polling detection latency). Measure it: run a handful of trivial builds across the
compute sizes/images v1 will use (arm1.small/medium, standard + custom ECR image,
privileged on/off) and record the `PROVISIONING` phase `durationInSeconds` from
`BatchGetBuilds`. Needs an AWS account and a throwaway CodeBuild project — agent-drivable
if credentials are available (AFK), otherwise a short human checklist.

The answer feeds [Run observability DX](005-run-observability-dx.md) (what latency UX to
promise) and validates the [Job compute runtime](001-job-compute-runtime.md) choice; a
pathological result (multi-minute provisioning) would reopen the Fargate question for
latency-sensitive jobs.

## Runbook

No AWS credentials are reachable from the dev machine (no CLI, no `~/.aws`), so this is
HITL: the measurement harness is built and the human runs it where credentials live.

- Asset: [prototypes/codebuild-provisioning-spike](../../prototypes/codebuild-provisioning-spike/README.md)
  — self-cleaning CloudShell script covering the full matrix (ARM small/medium ×
  standard/custom image × privileged on/off, 3 reps each) via `StartBuild` overrides.
- Human: run `bash measure.sh run` in CloudShell per the README, then bring the summary
  tables (or results JSON) back to a wayfinder session to resolve this ticket.

## Resolution

Measured 2026-08-08 in CloudShell; full tables in
[results-2026-08-08.md](../../prototypes/codebuild-provisioning-spike/results-2026-08-08.md).
All 24 builds succeeded across the full matrix (ARM small/medium × standard/custom
image × privileged on/off, 3 reps each).

**PROVISIONING is 2–7 seconds everywhere.** Cheapest case (standard image,
non-privileged) averages ~3 s; privileged mode adds ~3–4 s; a custom public-ECR image
adds ~2–3 s; effects don't stack beyond ~6 s and compute size makes no difference.
No pathological result — the multi-minute scenario that would have reopened the
Fargate question for latency-sensitive jobs did not materialize, so the
[Job compute runtime](001-job-compute-runtime.md) choice stands as-is.

**UX floor for [Run observability DX](005-run-observability-dx.md):** trigger fired →
first log line is dominated entirely by the ~30–90 s polling detection latency;
provisioning contributes single-digit seconds. The CLI can promise "typically under
two minutes from push to first log line" without hedging on provisioning.

**Side findings:**
- ARM `BUILD_GENERAL1_MEDIUM` on-demand works fine (its availability was uncertain).
- Bursts of 3 concurrent starts intermittently hit 30–40 s of `QUEUED` time (account
  concurrency throttling, mostly on the medium configs). Excluded from provisioning
  by design, but it's real-world input for
  [Concurrency semantics](015-concurrency-semantics.md): a fresh account absorbs
  small bursts with sub-minute queueing rather than failures.
- Private-ECR custom-image pull was not measured (public-ECR default used); no reason
  to expect a materially different number for typical image sizes.
