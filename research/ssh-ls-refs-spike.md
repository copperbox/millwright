# SSH ls-refs spike — findings

Resolves [SSH ls-refs spike](../wayfinder/tickets/016-ssh-ls-refs-spike.md).
Run 2026-08-09 with pure-JS `ssh2@1.17.0` on Node v26.4.0, authenticating with a
**read-only deploy key** (the exact production credential shape from
[Polling credential during outages](../wayfinder/tickets/011-polling-credential-during-outages.md)).
Spike script: [ssh-ls-refs-spike-script.js](ssh-ls-refs-spike-script.js).

## Verdict

**Confirmed.** GitHub's SSH frontend (babeld) honors a `GIT_PROTOCOL=version=2`
channel env request from a non-OpenSSH client. Protocol-v2 `ls-refs` with
`ref-prefix` works over `ssh2` exactly as it does over HTTPS, and the no-env
fallback yields the protocol-v0 advertisement as documented. Nothing blocks the
011 poller design.

## Measurements

SSH experiments ran against a throwaway fork (`dantheuber/git`, master at
`010afd3…`, deleted after); large-repo payload numbers are real `git/git` wire
sizes over unauthenticated HTTPS. The two compose: the filtered v2 ls-refs
response for the same query was **byte-identical (67 B) over SSH and HTTPS**,
so payload sizes are transport-independent.

| Measurement | Bytes |
| --- | --- |
| v2 capability advertisement (SSH, after env honored) | 157 |
| ls-refs request, `peel`+`symrefs`+1 ref-prefix (client→server) | 113 |
| ls-refs response, single-branch prefix (SSH and HTTPS identical) | **67** |
| v0 advertisement, 2-ref fork (SSH, no env) | 406 |
| v0 advertisement, real `git/git` — 5,282 refs (HTTPS wire size) | **344,844** |

Filtered v2 vs full v0 on git/git: **~5,100x smaller** — consistent with (and
stronger than) the ~600x the [Polling architecture](../wayfinder/tickets/002-polling-architecture.md)
verification measured over HTTPS on a different repo mix.

Timing per SSH poll connection (residential link, one sample each):
TCP+handshake+pubkey auth ~0.9–1.2 s; ls-refs round trip ~250 ms after the
capability ad; total connect-to-close ~1.4–1.9 s. Well inside a 1-min cadence.

## The working exchange sequence (poller reference)

1. `ssh2` `Client.connect({host: 'github.com', port: 22, username: 'git', privateKey})`.
2. On `ready`: `conn.exec("git-upload-pack 'owner/repo'", {env: {GIT_PROTOCOL: 'version=2'}}, cb)`.
   `ssh2` sends the env as a channel `env` request before `exec`; babeld accepts
   it silently (no want-reply gymnastics needed).
3. Server → client, pkt-lines, terminated by flush `0000`:
   `version 2`, `agent=git/github-…`, `ls-refs=unborn`,
   `fetch=shallow wait-for-done filter`, `server-option`, `object-format=sha1`.
   **Detect v2 by the first pkt-line being `version 2`** — if it's a
   `<40-hex> HEAD\0<caps>` line instead, the env was refused and this is the v0
   advertisement: read to flush, diff refs, done (fat but correct fallback).
4. Client → server:
   `0014command=ls-refs\n` · caps (e.g. `agent=…`) · delim `0001` ·
   `0009peel\n` · `000csymrefs\n` · `ref-prefix <prefix>\n` (repeatable) ·
   flush `0000`.
   (Mind the pkt-length arithmetic: length prefix counts itself, i.e. payload+4,
   hex, zero-padded to 4. Two hand-miscounts produced silent empty/400 responses
   during the spike — compute it, never hand-write it.)
5. Server → client: one `<40-hex> <refname>` pkt-line per matching ref (peeled
   `^{}` lines when annotated tags match), then flush.
6. Client sends flush and closes the connection; server closes cleanly.

## babeld quirks and notes

- **Env handling**: accepted from a non-OpenSSH client identifying as `ssh2`'s
  default banner; no `AcceptEnv`-style rejection observed, no stderr noise.
- **Pure JS confirmed**: npm's build scripts were blocked, so `ssh2`'s optional
  native addon (`cpu-features`) never built — everything above ran on the pure-JS
  path, validating 011's Lambda-friendly assumption.
- **Host key for pinning**: babeld presented an `ssh-ed25519` host key; `ssh2`'s
  `hostVerifier` callback receives the raw public-key blob, which is exactly
  what 011's SSM host-key pin + auto-reconcile needs — implement pinning there.
- **Stateful channel**: unlike HTTP's one-shot stateless-rpc, the SSH channel
  stays open after a v2 response; issuing multiple `ls-refs` commands per
  connection (e.g. several repos' worth of prefixes — one connection per repo is
  still required since the repo is fixed at `exec` time, but multiple prefix sets
  per repo would work) was **not** exercised. Possible micro-optimization, not a
  requirement — connect cost is ~1 s and cadence is 1 min.
- **Deploy-key scope**: cross-repo public-repo reads with a deploy key were not
  verified (test blocked). Irrelevant to the design — production always pairs
  each repo with its own key.
