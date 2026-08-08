---
id: "016"
title: SSH ls-refs spike
type: wayfinder:task
status: open
assignee: none
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
