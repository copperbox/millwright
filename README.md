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
