---
type: security
title: secretsAllowedRefs — the matcher and the gate
tags:
  - millwright
  - security
  - secrets
  - iam
timestamp: 2026-08-12T21:25:10.416Z
---

Which refs may receive workflow secrets is controlled by **`secretsAllowedRefs`** in the repo's SSM
config, set via `millwright repo add/update --secrets-refs`.

## Dialect

Patterns match the **short ref name as pushed** (`main`, `release/1.2`; tag names likewise),
**anchored at both ends**. `*` is the only metacharacter and **crosses `/`**. There is no implicit
prefix or substring behavior:

> `main` matches exactly `main` — **never** `mainline`.

The matcher ships with a test table. Code: `packages/millwright-state/src/secrets-refs.ts`.

## Enforcement point

**The decider, at dispatch**, via [job-role variant selection](job-roles.md). Synth-time checking is
**fail-fast UX only** — synth executes repo code and can never be the enforcement point.

## Defaults and structural rules

- **Unset means no ref receives secrets.** The shortest onboarding command is the safe one.
- **PR refs are structurally unmatchable**: `refs/pull/N` has no short name, so it can never match
  by construction. "No secrets on PR runs" is therefore a **v1 rule, not an emergent property** —
  it cannot be misconfigured away.

## The honest limit, documented loudly

An allowlisted ref *name* is only as strong as GitHub-side protection of that namespace.
`--secrets-refs 'release/*'` hands secrets to **anyone who can push `release/anything`**, unless a
repository ruleset protects that namespace. `doctor` warns where it can read ruleset state;
otherwise the documentation warning is the only control.

## How secrets actually arrive

Declared per job in the definition:

```ts
secrets: { NPM_TOKEN: Secret.named('npm-token'), X: Secret.fromSecretsManager(arn) }
```

`Secret.named('x')` resolves to `/millwright/<name>/secrets/<repo>/x` — scope defaults to the repo;
an explicit `scope:` addresses shared secrets. **No cross-repo ambient sharing.**

At runtime they arrive **pre-step-1** via CodeBuild-native `env.parameter-store` /
`env.secrets-manager` blocks, as env vars with **exact-match masking**. A repo-authored reference to
an *undeclared* parameter fails closed on the job role's missing grant.

Lint: **masking is exact-match-only** — transformed secret values (base64'd, interpolated) leak into
logs. File-shaped secrets are v1'd by a step writing the env var to disk; `SecretFile` is deferred.

# Citations

[1] [Spec §12a, §4.2, §11.2](../../docs/specs/1-millwright-v1-implementable-specification.md)
