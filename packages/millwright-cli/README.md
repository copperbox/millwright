# @copperbox/millwright-cli

The `millwright` command, for operator and developer machines. npx-able.

```sh
npx @copperbox/millwright-cli init   # scaffold the two-file CDK deployment app
millwright doctor                    # verify the deployment chain
```

AWS credentials (profile / SSO / env) are the only auth. The CLI lists
`/millwright/*` in SSM and auto-picks the deployment when the account+region
has exactly one; otherwise set `MILLWRIGHT_DEPLOYMENT` or pass `--deployment`.
