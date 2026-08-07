---
id: "013"
title: Runner image model
type: wayfinder:grilling
status: open
assignee: none
blocked-by: ["004"]
---

## Question

Jobs run as CodeBuild builds with a per-build `imageOverride` — so what's the v1 image
story? A default millwright job image (contents? maintained how?), custom images from
ECR/Docker Hub, toolchain setup (preinstalled vs setup-steps), and how the
workflow-definition API expresses the choice. Also: does millwright build/publish its
own base image as part of deployment? Blocked on
[Workflow-definition construct API](004-workflow-definition-api.md) for how it surfaces
in the API. Graduated from fog once CodeBuild was picked in
[Job compute runtime](001-job-compute-runtime.md).
