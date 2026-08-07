---
id: "002"
title: Polling architecture
type: wayfinder:research
status: open
assignee: research-subagent
blocked-by: []
---

## Question

How should millwright watch N repositories serverlessly, without webhooks?

- **Tier 1 (git protocol)**: EventBridge Scheduler → Lambda running `git ls-remote`
  (or smart-HTTP `info/refs` directly). Auth options for private repos from Lambda;
  invocation cost and latency at 1-minute polling across N repos; storing last-seen refs
  (DynamoDB?) and diffing to derive push/branch/tag events; feasible floor on
  detection latency.
- **Tier 2 (GitHub API, best-effort)**: polling REST/GraphQL for PR
  opened/updated/closed events. Rate limits per PAT vs GitHub App installation;
  conditional requests (ETag / If-Modified-Since) and whether 304s are rate-limit-free;
  realistic poll frequency for, say, 10–50 repos without exhausting limits.
- Behavior during GitHub degradation: backoff, jitter, avoiding thundering-herd retry;
  how to distinguish "GitHub down" from "repo gone".
- Rough monthly cost of the whole polling layer at 1-min tier-1 polls.

Deliver a recommended polling design. Findings on branch `research/polling-architecture`.
