---
id: "014"
title: Packaging and config surface
type: wayfinder:grilling
status: closed
assignee: dan
blocked-by: []
---

## Question

How does a team install and configure millwright? Is it a CDK **construct library**
(`new Millwright(stack, { ... })` inside their existing CDK app) or a standalone CDK
**app** they clone/configure — or a construct library with a thin reference app?
And what is the deployment-level config surface: the watched-repo list, per-repo
secrets-allowlist refs (from [ticket 004](004-workflow-definition-api.md)'s guardrails),
the IAM permissions boundary, artifact/cache retention, poll cadence, notification
targets. What's config-at-deploy vs config-in-repo? Graduated from fog once the
definition model landed.

## Resolution

Grilled with Dan (2026-08-08).

- **Packaging: construct library + thin generated app.** `@copperbox/millwright-cdk`
  exports `new Millwright(stack, {...})`; `millwright init` scaffolds a minimal
  two-file CDK app instantiating it for teams without an existing CDK app. CDK-native
  teams compose the construct into their own app. Upgrades are npm version bumps +
  `cdk deploy` — never a git merge of a cloned template.
- **Three npm packages under the existing `@copperbox` scope** (no dedicated org
  unless the project outgrows it), released in lockstep with one version:
  `millwright-workflows` (tiny definition lib — the only install in watched repos, no
  aws-cdk-lib), `millwright-cdk` (construct + bundled control-plane assets),
  `millwright-cli` (bin `millwright`, npx-able). Compatibility between a repo's
  workflows lib and the deployed control plane is governed by a versioned run-model
  `schemaVersion`: the control plane accepts schema ≤ its own; synth fails loud
  otherwise.
- **Config-split principle, refined while grilling**: security/cost config must be
  *operator-IAM-gated*, not necessarily deploy-gated. The [ticket
  004](004-workflow-definition-api.md) guardrail requirement is "not editable from a
  watched repo's branch"; a CLI writing SSM under operator AWS credentials satisfies
  it.
- **Repos are dynamic, not construct props.** `millwright repo add acme/api
  --secrets-refs main,release/*` writes a JSON config param
  (`/millwright/<name>/repos/<repo>/config`: `secretsAllowedRefs`, `prPolling`),
  generates the repo's Ed25519 deploy key into SSM SecureString under the existing
  CMK, and installs the public key via the App's admin permission (or prints it for
  manual add). No `cdk deploy` to add a repo. Allowlist edits go through
  `millwright repo update` — operator IAM required. The poller reads repo config by
  path prefix; DynamoDB stays purely run state.
- **Construct props are pure infra knobs**: `deploymentName` (default `millwright`),
  `permissionsBoundary`, `pollCadence` (default 1 min), `retention` (defaults 30d
  logs / 90d metadata + artifacts). Notification targets deliberately omitted —
  notifications remain fog.
- **CLI discovery: AWS credentials are the only auth** (profile/SSO/env — no
  millwright tokens). The construct self-registers a manifest param at
  `/millwright/<name>/manifest` (state table, log group, buckets); the CLI lists
  `/millwright/*` and auto-picks when the account+region has exactly one deployment,
  else requires `MILLWRIGHT_DEPLOYMENT` / `--deployment`. No committed pointer file
  in watched repos in v1.
- **Setup flow: discrete guided commands, no wizard.** `init` → plain `cdk deploy`
  (never wrapped; the operator owns the infra artifact) → `millwright setup` (GitHub
  App manifest handshake in browser, `--pat` fallback) → `millwright repo add` per
  repo → `millwright doctor` verifies the chain (SSM manifest, App creds, deploy
  keys, poller ticking).

**Constraints radiated**: the SSM config plane (`/millwright/<name>/...`) is now the
canonical home for per-repo config — polling, secrets injection, and check reporting
read repo config from there; `repo add`'s key-generation flow amends [Polling
credential during outages](011-polling-credential-during-outages.md)'s setup story
from "provisioned at deploy" to "provisioned at repo add". Spawned
[Assemble the v1 spec](017-assemble-v1-spec.md) as the map's terminus.
