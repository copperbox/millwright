---
id: "004"
title: Workflow-definition construct API
type: wayfinder:prototype
status: open
assignee: dan
blocked-by: []
---

## Question

What does the CDK-style TypeScript API for defining millwright workflows look like?
Sketch the construct model — Workflow / Job / Step (or whatever the right nouns are),
trigger bindings (push/branch/tag filters, PR events, cron, manual dispatch), job
dependencies/DAG, and what `synth` emits as the declarative job model. How does a
workflow definition coexist with the CDK infra app that deploys millwright itself
(same app? separate synth?).

Produce a rough `.ts` sketch of 2–3 realistic workflows (CI on push, deploy on tag,
PR checks) to react to live. The sketch is a discussion artifact, not a design commitment.
