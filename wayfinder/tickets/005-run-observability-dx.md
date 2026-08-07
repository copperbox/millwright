---
id: "005"
title: Run observability DX
type: wayfinder:grilling
status: open
assignee: dan
blocked-by: []
---

## Question

When a run executes, how does the user watch it? Decide the v1 observability surface:
CLI-first (`millwright runs`, `millwright logs -f`), a minimal web UI, raw CloudWatch,
or some mix. What run history, status, and log-tailing capabilities does the spec
require for v1, and what's explicitly deferred? This decision sizes a significant chunk
of the project.
