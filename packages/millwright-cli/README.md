# @copperbox/millwright-cli

The `millwright` command, for operator and developer machines. npx-able.

```sh
npx @copperbox/millwright-cli init   # scaffold the two-file CDK deployment app
millwright setup                     # create the GitHub App, pin host keys
millwright repo add acme/api         # onboard a repo end to end
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

## Local execution

`millwright run <wf>` is always local; `millwright dispatch <wf>` is always
cloud — the verb split makes running in the wrong place impossible. The local
host reuses the shared core end to end: the definition synths in-process, the
same buildspec renderer authors each job's phases, the same pure decider
drives the DAG (SKIPPED semantics, bounded retries, terminal states), and the
same step shim reports step status — against `docker run` and
`.millwright/runs/local-N.json` instead of CodeBuild and DynamoDB. Millwright
makes zero AWS calls locally; image pulls go through your own docker config.

- Source is the git-aware **working tree** (untracked-but-not-ignored files
  ride along); `--clean` runs from `git archive HEAD` instead.
- `--job X` runs one job, feeding its `consumes` from the newest prior local
  run's artifacts; `--job X --with-deps` runs the ancestor subgraph instead.
- Secrets come from the gitignored `.millwright/secrets.env` (or
  `--secrets-file <path>`) as `KEY=VALUE` lines keyed by the declared env
  var; missing declared secrets fail before any job starts. SSM and Secrets
  Manager are never read.
- Typed inputs for `Trigger.manual` workflows come from repeated
  `--input k=v` flags; required choice inputs with no default prompt
  interactively.
- `--platform <p>` passes through to docker for exact-arch parity;
  `--parallel N` bounds concurrent jobs (default: CPU count); `--as-tag <t>`
  fakes a tag ref for the run context. Privileged jobs mount the host docker
  socket (a fidelity note is printed). Concurrency groups are carried, not
  enforced, locally.
- Ctrl-C sets `cancelRequested` through the same decider path as
  `runs cancel`: in-flight containers stop and every state lands terminal.
- Run ids are `local-N`, monotonic per clone, gitignored under
  `.millwright/`, never mixed into `runs list`; `millwright runs show
  local-N` reads the state file. Artifacts land under
  `.millwright/runs/local-N/out/<job>/<artifact>/` (the cloud layout), and
  the keyed dependency cache persists across runs in `.millwright/cache/`.

The step shim binds in from the millwright-cdk package's built delivery
(`dist/shim`); point `MILLWRIGHT_SHIM_DIR` at a delivery directory to
override.

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
- `millwright runs cancel <run> [--repo <owner/name>]` — request
  cancellation: writes `cancelRequested` and wakes the decider if the run is
  in flight, which stops in-flight builds and lands every job terminal.
- `millwright runs rerun <run> [--repo <owner/name>] [--failed]` — create a
  new run from the stored job model, no re-synth; `--failed` reruns only
  failed jobs and their skipped dependents, reusing succeeded outputs.

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
