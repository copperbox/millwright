---
id: "008"
title: Secrets management and injection
type: wayfinder:grilling
status: open
assignee: dan
blocked-by: ["001"]
---

## Question

Where do workflow secrets live (Secrets Manager vs SSM Parameter Store), how are they
declared/referenced in workflow definitions, and how are they injected into running jobs
without leaking into logs or state? Blocked on
[Job compute runtime](001-job-compute-runtime.md): injection mechanics (env vars,
mounted files, IAM-scoped fetch at runtime) differ per compute service.
