# millwright

Polling-driven CI/CD that runs in your own AWS account. GitHub stays the
source of truth for code and collaboration; millwright replaces GitHub Actions
*execution* — no webhooks, no runners to babysit, as serverless as possible.

> **Early alpha — not production ready.** millwright has never been deployed
> outside development. The packages are unreleased, the interfaces below are
> expected to change without notice, and no upgrade path between versions is
> maintained yet. Treat everything here as a design you can try, not a service
> you can depend on. Bug reports from people who do try it are the most useful
> thing right now.

- **[Spec](docs/specs/1-millwright-v1-implementable-specification.md)** — the
  implementable v1 specification the code is built against.
- **[AWS cost analysis](docs/aws-cost-analysis.md)** — line-item estimate at 50
  watched repos: a few dollars a month idle, roughly $80–130/mo at 100 runs/day,
  dominated by CodeBuild minutes and CloudWatch Logs ingestion.

Deeper guides are linked from the sections below:
[deploying](docs/deployment.md) · [authoring workflows](docs/workflow-authoring.md)
· [running locally](docs/local-execution.md) · [operating](docs/operations.md).

## Packages

npm workspace with four packages under the `@copperbox` scope, released in
lockstep with a single version:

| Package | What | Installed where |
|---|---|---|
| [`@copperbox/millwright-workflows`](packages/millwright-workflows) | Workflow definition library. Zero dependencies — never pulls in `aws-cdk-lib`. | The only install in watched repos. |
| [`@copperbox/millwright-cdk`](packages/millwright-cdk) | The `Millwright` construct that deploys the control plane. | The operator's CDK app. |
| [`@copperbox/millwright-cli`](packages/millwright-cli) | `millwright` binary (npx-able). | Operator + developer machines. |
| [`@copperbox/millwright-state`](packages/millwright-state) | Shared control- and data-plane contracts: state/polling table keys, SSM config-plane paths, S3 layout, the buildspec renderer, the `secretsAllowedRefs` gate. | A dependency of the CDK and CLI packages, not installed directly. |

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
npx @copperbox/millwright-cli init   # scaffold the CDK app
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

**→ [Deployment guide](docs/deployment.md)** — prerequisites, the construct's
props, the GitHub App and PAT paths, verifying a first run, and teardown.

## Defining workflows (watched repos)

Workflows live at `millwright/workflows.ts` in the watched repo, written with
`@copperbox/millwright-workflows` (see that package's README for the API):

```ts
import { WorkflowSet, Workflow, Trigger } from '@copperbox/millwright-workflows';

const app = new WorkflowSet();
const ci = new Workflow(app, 'ci', { on: [Trigger.push({ branches: ['main'] })] });
ci.job('build', {
  image: 'public.ecr.aws/docker/library/node:22',
  steps: ['npm ci', 'npm test'],
});
export default app;
```

`npx millwright synth` compiles the definition to the JSON run model — the
contract between definition, cloud orchestration, and the local runner —
printing synth-time errors and lints to stderr.

**→ [Authoring workflows](docs/workflow-authoring.md)** — every trigger and job
option, dependencies, artifacts, caching, and how secrets are gated.
**→ [Running workflows locally](docs/local-execution.md)** — the local runner,
what it reproduces faithfully, and where it deliberately differs from cloud.

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
against the workflow's `Trigger.manual` declaration — choices are validated,
booleans take `true`/`false`, and a choice input with no default must be
supplied or the dispatch fails before any event is emitted. The event goes
onto the deployment's bus under your own AWS credentials with
`source: millwright.cli`; the bus resource policy and the launcher both reject
`dispatch` events from any other source.

### Checks and branch protection

Every cloud run reports to its commit sha: one check per job named
`<workflow> / <job>`, plus a `<workflow> / synth` check per run that is
created `in_progress` at run start and fails with the synth error in its
summary when `millwright/workflows.ts` is broken. In branch protection,
require the gating workflows' `<workflow> / synth` contexts (and whichever
job contexts should gate) — not `millwright / synth`, which only
bootstrap-only executions report. PAT-mode deployments report commit
statuses under identical context names, so the same required contexts work.

## Operating runs

```sh
millwright runs cancel <run>            # stop in-flight builds; every job lands terminal
millwright runs rerun <run> [--failed]  # new run from the stored job model — no re-synth
```

`<run>` is `owner/name#workflow#number`, or `workflow#number` with
`--repo <owner/name>`. `--failed` reruns only the failed jobs and their
skipped dependents, reusing the source run's succeeded outputs.

**→ [Operating a deployment](docs/operations.md)** — where the logs live, the
run state model, a troubleshooting playbook, credential rotation, and the
cost and capacity levers.
