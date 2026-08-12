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
```

The deployed construct self-registers a manifest at
`/millwright/<name>/manifest`; the CLI discovers it with zero configuration
when the account+region has exactly one deployment (otherwise set
`MILLWRIGHT_DEPLOYMENT` or pass `--deployment`).

## Cron and manual dispatch

**Cron runs on the poll tick, in UTC.** There is no separate scheduler: the
poller tick doubles as the cron clock, so cron granularity is the deployment's
`pollCadence`. At the default one-minute cadence a `Trigger.cron` expression
fires per matching minute; with a longer cadence each tick fires at most once
per entry, for the latest matching minute (the construct warns about this at
synth time). Cron expressions are the standard five fields, evaluated in
**UTC** — there is no timezone option. Cron is ref-less: entries are read from
the repo's default-branch registry entry and always run the default-branch
head. After a poller outage each cron entry catches up with **exactly one**
run — the latest matching minute in the gap — never the whole backlog.

**Manual dispatch is always cloud.**

```sh
millwright dispatch <workflow> [--ref <ref>] [--input k=v ...]
```

Runs from a checkout of the watched repo (or pass `--repo owner/name`). The
ref defaults to the default-branch head and is resolved to a sha before the
event is emitted, pinning definition and source together. Inputs are typed
against the workflow's `Trigger.manual` declaration — choices are validated
and booleans take `true`/`false`. The event goes onto the deployment's bus
under your own AWS credentials with `source: millwright.cli`; the bus resource
policy and the launcher both reject `dispatch` events from any other source.
