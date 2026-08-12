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
model to stdout (or `--out <file>`).

AWS credentials (profile / SSO / env) are the only auth. The CLI lists
`/millwright/*` in SSM and auto-picks the deployment when the account+region
has exactly one; otherwise set `MILLWRIGHT_DEPLOYMENT` or pass `--deployment`.
