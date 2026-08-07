---
id: "006"
title: Orchestration and state model
type: wayfinder:grilling
status: open
assignee: none
blocked-by: ["001"]
---

## Question

What orchestrates a run — executing the job DAG, retries, timeouts, fan-out, cancellation
— and what stores run/job state and history? Candidates: Step Functions driving the
compute, DynamoDB + EventBridge choreography, or a hybrid. Blocked on
[Job compute runtime](001-job-compute-runtime.md): the compute choice changes what
orchestration is natural (e.g. Step Functions has first-class CodeBuild/ECS
integrations).
