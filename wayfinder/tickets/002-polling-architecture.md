---
id: "002"
title: Polling architecture
type: wayfinder:research
status: closed
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

## Resolution

**EventBridge Scheduler `rate(1 minute)` (with jitter window) → one small non-VPC Lambda
that polls every repo per tick, diffs against per-repo DynamoDB ref state, and emits
push/branch/tag/PR events to an EventBridge bus.** Full findings:
`research/polling-architecture.md` on branch `research/polling-architecture`.

- **Tier 1 without a git binary**: git smart-HTTP protocol-v2 `ls-refs` with
  `ref-prefix` filtering — verified live at ~600x smaller payloads than the v0
  advertisement (578 bytes vs 344 KB for git/git). Two plain HTTPS calls per repo.
- **Git protocol sits outside the REST quota** (no published hard limit, dynamic
  throttling only) — but since May 2025 *unauthenticated* git-over-HTTPS is rate
  limited, so every poll must authenticate, public repos included.
- **Tier 2**: `GET /repos/{o}/{r}/pulls?state=all&sort=updated` with per-repo ETags;
  authenticated 304s don't count against the primary rate limit, so steady state is
  nearly free. 50 repos at 1-min polls worst-case ≈ 3,000 req/hr — inside a 5,000/hr
  App-installation budget. Recommended cadence band: 60–120 s.
- **Latency floor**: ~30–90 s typical detection, ~2 min worst case; sub-minute needs
  self-rescheduling hacks and isn't worth it.
- **Outage handling**: DynamoDB circuit-breaker item, quorum-based (transport/5xx errors
  across ≥3 repos ⇒ open; canary probe with decaying interval). Authenticated 404 =
  per-repo quarantine (GitHub deliberately conflates deleted vs access-revoked).
- **Cost**: ~$0.80–2.40/mo for 10–50 repos at list price; near-zero under free tiers.
  Poller must stay non-VPC or NAT (~$32/mo) dominates the whole stack.

**Constraints radiated to other tickets**: Step Functions Standard must never be on the
per-poll path (on-change only; downstream consumes EventBridge events). Tier 1 can't
distinguish force-push from fast-forward or identify the pusher — actor/commit metadata
requires lazy API fetches that degrade with GitHub. DynamoDB's 400 KB item cap can bite
on 1,000+-tag repos; plan ref-map compression. **Tension with the Repo access auth
resolution**: this design polls with an App installation token as the git HTTPS
password, but App token minting dies ≤1h into an API outage — see the follow-up ticket
[Polling credential during outages](011-polling-credential-during-outages.md).
