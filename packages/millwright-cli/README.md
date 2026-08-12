# @copperbox/millwright-cli

The `millwright` command, for operator and developer machines. npx-able.

```sh
npx @copperbox/millwright-cli init   # scaffold the two-file CDK deployment app
millwright synth                     # compile millwright/workflows.ts to the JSON run model
millwright doctor                    # verify the deployment chain
```

`millwright synth` loads the repo's `millwright/workflows.ts` in-process (no
build step needed in the watched repo), derives repo/commit from git when
`--repo`/`--commit` are omitted, prints diagnostics to stderr and the run
model to stdout (or `--out <file>`). Cache keys are resolved here too:
`hashFiles(...)` parts are hashed against the checkout, so the model carries
final key strings.

AWS credentials (profile / SSO / env) are the only auth. The CLI lists
`/millwright/*` in SSM and auto-picks the deployment when the account+region
has exactly one; otherwise set `MILLWRIGHT_DEPLOYMENT` or pass `--deployment`.

The package's dist also ships `synth-job.bundle.js` (built by
`npm run bundle-synth-job`): the cloud synth job's entry point, which the
`Millwright` construct stages as an S3 asset and runs inside the CodeBuild
synth build — clone via deploy key, lockfile-discovered install, in-process
synth, `model.json` + `source.tar.gz` upload. It is the control plane's own
tooling; watched repos never install it.
