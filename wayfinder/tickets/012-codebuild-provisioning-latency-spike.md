---
id: "012"
title: CodeBuild provisioning-latency spike
type: wayfinder:task
status: open
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
