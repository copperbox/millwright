---
id: "011"
title: Polling credential during outages
type: wayfinder:grilling
status: closed
assignee: dan
blocked-by: []
---

## Question

The [Polling architecture](002-polling-architecture.md) resolution polls git over HTTPS
using a GitHub App installation token as the password (one credential system, O(1)
setup). The [Repo access auth](003-repo-access-auth.md) resolution found App tokens die
≤1 hour into a GitHub API outage — the exact moment tier-1 polling must keep working —
which is why it recommended per-repo SSH deploy keys for the git path.

Reconcile them. Options include: (a) poll with the App token day-to-day and fail over to
deploy keys when the circuit breaker opens (best of both, two credential systems to
maintain); (b) deploy keys always (outage-proof, but O(n) setup and SSH from Lambda);
(c) App token only, accepting that a >1h API outage also pauses *detection* — noting
jobs already queued keep running, and manual dispatch still works. The answer sets how
much credential machinery the setup CLI and poller must carry.

## Resolution

**(b) Deploy keys always.** The everyday path is the outage path — no failover
machinery, nothing that only runs (and rots) during rare outages. The App token
retreats to REST-only work (tier-2 PR polling, check reporting), which shares fate
with the API anyway. The O(n)-setup objection was moot: [Repo access
auth](003-repo-access-auth.md) already mandates a per-repo deploy key for CodeBuild
cloning, so the key onboarding cost is paid regardless of this ticket.

- **Transport**: pure-JS `ssh2` in the existing zip-based poller Lambda — exec
  `git-upload-pack 'owner/repo'` with a `GIT_PROTOCOL=version=2` channel env,
  reusing the hand-rolled pkt-line/`ls-refs` parser from the HTTPS design. The
  ~600x `ref-prefix` payload savings carry over; the protocol-v0 advertisement is
  the documented fat-but-correct fallback if babeld refuses the env from a
  non-OpenSSH client. Verified by the spawned
  [SSH ls-refs spike](016-ssh-ls-refs-spike.md) before the spec is final.
- **Host keys**: pinned from the `/meta` REST endpoint into SSM at setup;
  compiled-in published fingerprints as day-one defaults; on mismatch the poller
  re-fetches `/meta` over TLS and auto-reconciles with an alarm only if it
  confirms the new key, hard-failing otherwise; manual `refresh-host-keys` CLI
  escape hatch. SSH host keys don't expire — no renewal cycle exists; GitHub has
  rotated once ever (RSA, March 2023, emergency).
- **Deploy keys are a universal invariant of every deployment.** App-vs-PAT
  shrinks to a pure REST-surface choice; the tier-1 path has one code path in all
  modes. (A fine-grained PAT with repo Administration:write can create deploy
  keys, so PAT-mode onboarding stays automated.)
- **Key storage**: SSM SecureString under millwright's existing CMK — *amending*
  [Repo access auth](003-repo-access-auth.md)'s "Secrets Manager holds the keys"
  line, which predated [Secrets management](008-secrets-injection.md) choosing SSM
  as the secrets substrate. Per-repo Secrets Manager entries would cost
  $0.40/secret/mo ($20/mo at 50 repos), 10x the whole polling stack; SSM standard
  tier is free and Ed25519 keys (~400 B; minted by default) fit the 4 KB limit.
  The App PEM moves to SSM under the same CMK for the same reason. Poller
  batch-fetches via `GetParameters` on cold start and caches decrypted keys in
  memory while warm.
- **Breaker/quarantine transfer mechanically**: the quorum circuit breaker now
  watches SSH transport failures (it no longer guards credential lifecycle — that
  failure mode is gone); per-repo quarantine triggers on SSH "Repository not
  found" / key-auth rejection, which conflates deleted-vs-revoked exactly as
  authenticated HTTPS 404s did.
