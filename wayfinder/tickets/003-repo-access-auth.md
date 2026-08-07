---
id: "003"
title: Repo access auth
type: wayfinder:research
status: closed
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

## Resolution

**Hybrid auth: a per-deployment GitHub App for API work + per-repo read-only deploy keys
for the git-protocol path.** Full findings: `research/repo-access-auth.md` on branch
`research/repo-access-auth` (not merged; all facts cited to docs.github.com).

- The App is primary for REST work: Contents: read, Checks: write, Commit statuses:
  write. Registered via the **manifest flow** (`POST /app-manifests/{code}/conversions`
  returns app ID + PEM + secrets in one exchange), so millwright's setup CLI can make
  single-tenant App creation nearly turnkey. Rate limit: ≥5,000 req/hr per installation,
  scaling with repo/user count, cap 12,500.
- **The App alone fails the resilience requirement**: installation tokens are minted via
  the REST API and live ≤1 hour, so an API outage kills App-based git access within an
  hour. Deploy keys (SSH) never touch the API — they keep tier-1 polling/cloning alive
  during API outages. This is why the hybrid is mandatory, not optional.
- Fine-grained PAT is the documented low-friction fallback for small setups (5,000/hr
  shared across all the user's tokens, doesn't scale with repos; commit statuses only —
  check runs are App-only per the Checks API docs).
- Git-protocol operations have no published hourly quota — poll via `git ls-remote`/SSH,
  preserving the REST budget for reporting.
- Secrets Manager holds the App PEM + deploy private keys only; installation tokens are
  cached (memory/DynamoDB), never stored as rotated secrets.

**Constraints radiated to other tickets**: PR check reporting should be a durable queue
that flushes when the API recovers; polling must use git protocol, not REST; the setup
CLI owns the manifest handshake and automated deploy-key onboarding (O(1 key per repo),
keys can't be shared across repos).
