---
id: "016"
title: SSH ls-refs spike
type: wayfinder:task
status: closed
assignee: dan
blocked-by: []
---

## Question

[Polling credential during outages](011-polling-credential-during-outages.md) moved
tier-1 polling to SSH deploy keys via pure-JS `ssh2`, on the expectation that GitHub's
SSH frontend (babeld) honors a `GIT_PROTOCOL=version=2` channel env request from a
non-OpenSSH client, enabling protocol-v2 `ls-refs` with `ref-prefix` filtering — the
~600x payload savings the [Polling architecture](002-polling-architecture.md) verified
over HTTPS.

Prove it live, mirroring 002's verification style: a ~20-line script that connects with
`ssh2`, execs `git-upload-pack 'owner/repo'` with the `GIT_PROTOCOL` env, performs the
v2 `ls-refs` exchange with `ref-prefix`, and records observed payload sizes against a
large repo (e.g. git/git). Also confirm behavior when the env is refused (expect the
protocol-v0 advertisement — fat but correct, the documented fallback).

Record: whether v2 negotiates, payload sizes, any babeld quirks (env handling, channel
semantics), and the working exchange sequence as a reference for the poller
implementation. Findings on a throwaway `research/ssh-ls-refs-spike` branch, linked
here.

## Resolution

**Confirmed live, 2026-08-09.** babeld honors `GIT_PROTOCOL=version=2` sent as an
SSH channel env request from pure-JS `ssh2@1.17.0` (no native addon built), exec'ing
`git-upload-pack 'owner/repo'` authenticated with a read-only deploy key — the
production credential shape from
[Polling credential during outages](011-polling-credential-during-outages.md).

- **v2 negotiates**: server answers the env with a 157 B v2 capability advertisement
  (`version 2`, `ls-refs=unborn`, `fetch=…`, `object-format=sha1`); the v2 `ls-refs`
  exchange with `peel`/`symrefs`/`ref-prefix` then works exactly as over HTTPS — the
  single-branch response was **byte-identical (67 B) over SSH and HTTPS**.
- **Payload sizes**: filtered v2 response 67 B vs the real `git/git` v0 advertisement
  of **344,844 B across 5,282 refs** (HTTPS wire measurement; transport-equivalent per
  above) — **~5,100x**, corroborating
  [Polling architecture](002-polling-architecture.md)'s HTTPS finding.
- **Fallback confirmed**: without the env, babeld streams the protocol-v0
  advertisement immediately — fat but correct; detect by first pkt-line
  (`version 2` vs `<sha> HEAD\0<caps>`).
- **Quirks**: none blocking. Env accepted silently from a non-OpenSSH client; `ssh2`'s
  `hostVerifier` exposes the raw `ssh-ed25519` host-key blob (feeds 011's SSM host-key
  pinning); ~1 s connect+auth, ~250 ms ls-refs round trip — trivial inside the 1-min
  cadence. Multi-command reuse of the open v2 channel exists but wasn't exercised
  (unneeded at v1 scale).

Full findings + annotated exchange sequence + spike script:
`research/ssh-ls-refs-spike.md` on the **`research/ssh-ls-refs-spike`** branch.
Method note: SSH runs hit a throwaway single-branch fork (`dantheuber/git`) via a
temporary deploy key (since deleted); large-repo numbers are unauthenticated HTTPS
wire sizes from upstream `git/git`. The leftover fork needs manual deletion
(`delete_repo` scope unavailable).
