# millwright

Polling-driven CI/CD that runs in your own AWS account. GitHub stays the
source of truth for code and collaboration; millwright replaces GitHub Actions
*execution* — no webhooks, no runners to babysit, as serverless as possible.

Spec: [`docs/specs/1-millwright-v1-implementable-specification.md`](docs/specs/1-millwright-v1-implementable-specification.md)

## Packages

npm workspace with four packages under the `@copperbox` scope, released in
lockstep with a single version:

| Package | What | Installed where |
|---|---|---|
| [`@copperbox/millwright-workflows`](packages/millwright-workflows) | Workflow definition library. Zero dependencies — never pulls in `aws-cdk-lib`. | The only install in watched repos. |
| [`@copperbox/millwright-cdk`](packages/millwright-cdk) | The `Millwright` construct that deploys the control plane. | The operator's CDK app. |
| [`@copperbox/millwright-cli`](packages/millwright-cli) | `millwright` binary (npx-able). | Operator + developer machines. |
| [`@copperbox/millwright-state`](packages/millwright-state) | Shared data-plane helpers: state/polling table keys, SSM config-plane paths, S3 layout. | A dependency of the CDK and CLI packages, not installed directly. |

## Developing

```sh
npm install
npm run typecheck
npm test
npm run build
```

Releases bump every package to one version, then publish them all:

```sh
npm run set-version -- 0.2.0
npm run build
npm publish --workspaces
```

## Getting started (operators)

```sh
npx @copperbox/millwright-cli init   # scaffold the two-file CDK app
npm install && npx cdk deploy        # deploy the control plane
millwright setup                     # create the GitHub App, pin host keys
millwright repo add acme/api         # onboard a repo end to end
```

`setup` creates the per-deployment GitHub App via the manifest flow (or takes
a fine-grained PAT with `--pat`); `repo add` writes the repo's config, mints
and installs a read-only deploy key, verifies it over SSH, and primes the
registry. See the [CLI README](packages/millwright-cli) for details.

The deployed construct self-registers a manifest at
`/millwright/<name>/manifest`; the CLI discovers it with zero configuration
when the account+region has exactly one deployment (otherwise set
`MILLWRIGHT_DEPLOYMENT` or pass `--deployment`).

### Checks and branch protection

Every cloud run reports to its commit sha: one check per job named
`<workflow> / <job>`, plus a `<workflow> / synth` check per run that is
created `in_progress` at run start and fails with the synth error in its
summary when `millwright/workflows.ts` is broken. In branch protection,
require the gating workflows' `<workflow> / synth` contexts (and whichever
job contexts should gate) — not `millwright / synth`, which only
bootstrap-only executions report. PAT-mode deployments report commit
statuses under identical context names, so the same required contexts work.
