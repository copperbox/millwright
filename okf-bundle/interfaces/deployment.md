---
type: interface
title: Deployment shape and CLI discovery
tags:
  - millwright
  - cdk
  - packaging
  - cli
timestamp: 2026-08-12T21:27:16.148Z
---

## Construct library + thin generated app

`millwright init` scaffolds a minimal **two-file CDK app** instantiating `new Millwright(...)`;
CDK-native teams compose the construct into their own app instead.

```ts
new Millwright(stack, 'Millwright', {
  deploymentName: 'millwright',      // default; namespaces SSM + resources
  permissionsBoundary: boundaryArn,  // REQUIRED — construct throws without it
  pollCadence: Duration.minutes(1),  // default 1 min
  retention: { logs: Duration.days(30), metadata: Duration.days(90) },
});
```

**Upgrades are npm version bumps + `cdk deploy` — never a git merge of a cloned template.** That is
the whole reason for the library/app split: a scaffolded template that operators edit would make
every upgrade a merge conflict.

`permissionsBoundary` is the only required prop — see
[permissionsBoundary](../security/permissions-boundary.md).

Notification targets are **deliberately absent** (notifications are deferred).

## Onboarding flow

```sh
npx @copperbox/millwright-cli init   # scaffold the CDK app
npm install && npx cdk deploy        # deploy the control plane
millwright setup                     # create the GitHub App, pin host keys
millwright repo add acme/api         # onboard a repo end to end
millwright doctor
```

**Adding a repo does not require `cdk deploy`** — see
[SSM config plane](../schemas/ssm-config-plane.md).

## CLI discovery and auth

**AWS credentials are the CLI's only auth** — profile / SSO / env. There are no millwright tokens
and no committed pointer file in watched repos.

The construct **self-registers a manifest** at `/millwright/<name>/manifest`. The CLI lists
`/millwright/*` and auto-picks when the account+region has exactly one deployment; otherwise it
requires `MILLWRIGHT_DEPLOYMENT` or `--deployment`.

Code: `packages/millwright-cdk/src/millwright.ts`, `packages/millwright-cli/src/discovery.ts`,
`init.ts`.

# Citations

[1] [Spec §3.2, §3.3, §3.4](../../docs/specs/1-millwright-v1-implementable-specification.md)
