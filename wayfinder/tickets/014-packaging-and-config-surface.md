---
id: "014"
title: Packaging and config surface
type: wayfinder:grilling
status: open
assignee: dan
blocked-by: []
---

## Question

How does a team install and configure millwright? Is it a CDK **construct library**
(`new Millwright(stack, { ... })` inside their existing CDK app) or a standalone CDK
**app** they clone/configure — or a construct library with a thin reference app?
And what is the deployment-level config surface: the watched-repo list, per-repo
secrets-allowlist refs (from [ticket 004](004-workflow-definition-api.md)'s guardrails),
the IAM permissions boundary, artifact/cache retention, poll cadence, notification
targets. What's config-at-deploy vs config-in-repo? Graduated from fog once the
definition model landed.
