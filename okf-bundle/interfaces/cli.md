---
type: interface
title: CLI command surface
tags:
  - millwright
  - cli
  - operations
timestamp: 2026-08-12T21:27:41.241Z
---

`millwright` is the whole UX — **there is no web UI in v1**.

```
Setup & ops
  millwright init
  millwright setup [--pat]
  millwright repo add <owner/repo> [--secrets-refs <refs>] [--no-pr-polling]
                     [--fork-prs <on|off>] [--ecr-repos <arns>]
  millwright repo update <owner/repo> [--secrets-refs <refs>] [--pr-polling <bool>]
                     [--fork-prs <on|off>] [--ecr-repos <arns>]
  millwright repo list | repo remove <owner/repo>
  millwright doctor
  millwright refresh-host-keys
  millwright secrets set <name> [--scope <scope>]

Definition
  millwright synth

Execution
  millwright run <wf> [--job X [--with-deps]] [--clean] [--platform <p>]
                 [--secrets-file <path>] [--input k=v ...] [--as-tag <tag>]
                 [--parallel N]            always local
  millwright dispatch <wf> [--ref <ref>] [--input k=v ...]   always cloud

Observability
  millwright logs [-f] [<run>] [--job <name>] [--failed] [--full]
  millwright runs list [--workflow <wf>] [--ref <ref>] [--status <s>]
  millwright runs show [<run>]
  millwright runs rerun <run> [--failed]
  millwright runs cancel <run>
```

## Things worth knowing

- **Run identity** is `owner/name#workflow#number` (e.g. `ci#142`), or `workflow#number` with
  `--repo <owner/name>`. Commands default to the latest run.
- **`run` is always local, `dispatch` is always cloud.** The pairing is absolute.
- **`repo add` does the whole onboarding**: writes repo config, mints and installs a read-only
  deploy key, verifies it over SSH, and emits a `bootstrap` event that primes the
  [registry](../architecture/per-ref-registry.md) — ending with a visible synth check.
- **`doctor` verifies the chain**: SSM manifest, App creds (including a per-repo pulls probe),
  deploy keys, poller ticking + last-tick duration. It **FAILS** (not warns) on missing
  default-branch registry entries. It also reports CodeBuild concurrency + IAM quotas and makes
  best-effort ECR resource-policy and branch-ruleset checks.
- Log tailing is polled `GetLogEvents` (~2 s), deep-linking to CloudWatch. **Logs are never the UX.**

Code: `packages/millwright-cli/src/`.

# Citations

[1] [Spec §15](../../docs/specs/1-millwright-v1-implementable-specification.md)
[2] [Operating a deployment](../../docs/operations.md)
