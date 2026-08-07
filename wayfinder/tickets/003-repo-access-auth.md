---
id: "003"
title: Repo access auth
type: wayfinder:research
status: open
assignee: research-subagent
blocked-by: []
---

## Question

How should a self-deployed millwright authenticate to GitHub for (a) polling and cloning
private repos, and (b) posting commit statuses / check runs on PRs? Compare
**GitHub App**, **deploy keys**, and **fine-grained PAT**:

- Rate limits each grants (git operations and REST API), and how they scale with repo
  count.
- Token lifetime and rotation story; where credentials live in AWS (Secrets Manager?)
  and how they're rotated.
- Resilience during GitHub incidents: does GitHub App installation-token *issuance*
  depend on API availability (an outage-coupling risk for tier-1 git polling)? Do deploy
  keys / PATs keep git-protocol access alive when the API is down?
- Setup ergonomics for a team deploying millwright into their own account (App
  creation/installation flow vs dropping a PAT in a secret).
- Least-privilege: minimum scopes/permissions for clone + checks:write.

Deliver a recommendation (possibly a hybrid, e.g. deploy key for git + App for checks).
Findings on branch `research/repo-access-auth`.
