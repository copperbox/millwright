# @copperbox/millwright-cli

The `millwright` command, for operator and developer machines. npx-able.

```sh
npx @copperbox/millwright-cli init   # scaffold the two-file CDK deployment app
millwright setup                     # create the GitHub App, pin host keys
millwright repo add acme/api         # onboard a repo end to end
millwright doctor                    # verify the deployment chain
```

AWS credentials (profile / SSO / env) are the only auth. The CLI lists
`/millwright/*` in SSM and auto-picks the deployment when the account+region
has exactly one; otherwise set `MILLWRIGHT_DEPLOYMENT` or pass `--deployment`.

## GitHub auth

`millwright setup` creates the per-deployment GitHub App via the manifest
flow: it serves a one-page local site, the browser round-trips through
GitHub's App-creation approval, and the resulting App id + private key PEM
land at `/millwright/<name>/github/app` as a SecureString under the
deployment CMK. Permissions: Contents read, Checks write, Commit statuses
write, Pull requests read, Administration write (deploy-key install). No
webhook — millwright polls. Setup also pins GitHub's SSH host keys from the
`/meta` endpoint into `/millwright/<name>/github/host-keys`.

The Administration permission has a documented blast radius: a stolen App PEM
permits installing an attacker deploy key on every watched repo — persistent
private-code read. That is why the PEM sits behind the two-gate SSM+CMK
posture, and why `setup --pat` exists as the tighter-scoping alternative: a
fine-grained PAT reports commit statuses instead of check runs with identical
context names, so branch protection works the same.

Installation tokens are minted on demand and held in memory only — never in
DynamoDB, never as rotated secrets.

## Repo onboarding

`millwright repo add <owner/repo>` writes the repo's config parameter, mints
a per-repo read-only Ed25519 deploy key (stored in SSM under the CMK),
installs it via the App's Administration permission (or prints it for a
manual add), verifies it by resolving the default-branch head over SSH
`ls-refs`, and emits a `bootstrap` event (`source: millwright.cli`) so
onboarding ends with a primed registry and a visible synth check. On an
empty repo it prints that triggers activate on the first push.

Deploy keys carry all git-protocol work (tier-1 polling, the synth clone);
the App token carries REST-only work. Flags:

- `--secrets-refs <patterns>` — ref names whose runs receive secrets
  (default: none).
- `--no-pr-polling` — disable tier-2 PR polling for this repo.
- `--fork-prs on|off` — run fork-authored PRs (default off).
- `--ecr-repos <arns>` — private-ECR repositories this repo's jobs may pull.

`repo update` changes any of those (unspecified flags keep their values),
`repo list` shows the configured repos, and `repo remove` deletes the
config + key parameters and best-effort removes the GitHub-side deploy key.
