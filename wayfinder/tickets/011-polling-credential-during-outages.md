---
id: "011"
title: Polling credential during outages
type: wayfinder:grilling
status: open
assignee: none
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
