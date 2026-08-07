---
id: "010"
title: PR check reporting
type: wayfinder:grilling
status: open
assignee: none
blocked-by: ["003"]
---

## Question

How do millwright run results appear on GitHub PRs — check runs vs commit statuses,
support for required-check gating, and what happens when the GitHub API is degraded
(queue and replay results once it recovers?). Blocked on
[Repo access auth](003-repo-access-auth.md): what we can post depends on how we
authenticate (check runs require a GitHub App).
