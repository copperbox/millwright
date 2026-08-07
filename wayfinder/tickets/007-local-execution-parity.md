---
id: "007"
title: Local execution parity
type: wayfinder:prototype
status: open
assignee: none
blocked-by: ["004"]
---

## Question

How does the exact workflow definition that runs in AWS also run locally with fast
feedback — the core DX promise? What is the contract between synth output and a local
runner; what fidelity is promised (e.g. same container image locally via docker, but
not the same compute service); how are secrets/artifacts faked or bridged locally?
Blocked on [Workflow-definition construct API](004-workflow-definition-api.md) — the
local runner consumes whatever synth emits.
