---
type: interface
title: Packages and release model
tags:
  - millwright
  - packaging
  - npm
timestamp: 2026-08-12T21:27:07.014Z
---

An npm workspace with **four** packages under the `@copperbox` scope, **released in lockstep with a
single version**. (The spec names three; `millwright-state` was factored out during implementation
as the shared contract layer and is not installed directly.)

| Package | Contents | Installed where |
|---|---|---|
| `@copperbox/millwright-workflows` | Definition library: `WorkflowSet`, `Workflow`, `Trigger`, `Secret`, `Artifact`, `Cache`, `Compute`, `Step`, `hashFiles`. **Zero dependencies — never pulls in `aws-cdk-lib`.** | The only install in watched repos. |
| `@copperbox/millwright-cdk` | The `Millwright` construct + bundled control-plane assets (Lambda code, shim binary, synth tooling bundle, state machine). | The operator's CDK app. |
| `@copperbox/millwright-cli` | `bin: millwright`; npx-able. | Operator + developer machines. |
| `@copperbox/millwright-state` | Shared control- and data-plane contracts: state/polling table keys, SSM paths, S3 layout, the buildspec renderer, the decider, the `secretsAllowedRefs` gate. | A dependency of the CDK and CLI packages. |

## Why `millwright-workflows` has zero dependencies

It is installed in **every watched repo**. Pulling `aws-cdk-lib` into an application repo's
dependency tree to define a CI workflow would be an unacceptable tax, and would blur the line
between "millwright's own deployment is CDK" and "your workflows are not CDK".

## Developing and releasing

```sh
npm install && npm run typecheck && npm test && npm run build

npm version 0.2.0               # bump every package to one version
npm run build
npm publish --workspaces
```

`npm run check-version` (`scripts/set-version.mjs --check`) asserts the lockstep without writing:
every manifest on the root version, every `@copperbox/millwright-*` range at `^<version>`, every
`src/version.ts` `VERSION` matching. `.github/workflows/ci.yml` runs typecheck, test, build, and
this check on pull requests and pushes to `main`. The root `version` lifecycle script fans an
`npm version` bump through `set-version.mjs` and refreshes the lockfile; publishing stays manual.

## Related

- [Deployment construct](deployment.md) · [Run model](../schemas/run-model.md) for the
  `schemaVersion` skew contract.

# Citations

[1] [Spec §3.1](../../docs/specs/1-millwright-v1-implementable-specification.md)
[2] [README](../../README.md)
