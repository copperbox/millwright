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

## Observability

The state table is the CLI's source of truth — there is no web UI. Runs are
named `<workflow>#<number>` (`ci#142`), qualified as `owner/repo/ci#142` when
two watched repos share a workflow name. Wherever a run argument is optional,
the latest run is the default.

- `millwright runs list [--workflow <wf>] [--ref <ref>] [--status <s>]` —
  recent runs, newest first.
- `millwright runs show [<run>]` — one run's jobs and steps, including job
  reuse, skip reasons, supersession, and abandoned check reporting, with
  CloudWatch deep links to each job's logs.
- `millwright logs [-f] [<run>] [--job <name>] [--failed] [--full]` — print a
  run's job logs. `-f` tails via polled `GetLogEvents` (~2 s cadence),
  `--failed` narrows to failed jobs, `--full` dumps each stream from the
  beginning.

`millwright doctor` verifies the whole chain: the manifest, GitHub
credentials (including a per-repo pull-request read probe), each repo's
deploy key over SSH, poller health, and registry priming — a repo that is
being polled but has no default-branch registry entry is a hard failure
naming the bootstrap remedy. It also reports CodeBuild concurrency and IAM
role quotas, and best-effort checks ECR resource policies and the branch
rulesets protecting `secretsAllowedRefs`. Exits non-zero when any check
fails.

## Secrets and host keys

`millwright secrets set <name> [--scope <scope>]` prompts for the value
(never echoed) and writes `/millwright/<deployment>/secrets/<scope>/<name>`
as a SecureString under the deployment CMK. The scope defaults to the repo of
the working directory's `origin` remote; secrets flow only to runs on refs
matched by the repo's `secretsAllowedRefs`.

`millwright refresh-host-keys` re-pins GitHub's SSH host keys from the
`/meta` endpoint — the manual hatch for confirmed key rotations. The poller
honors the new pins on its next tick.
