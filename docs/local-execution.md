# Running workflows locally

`millwright run <workflow>` executes a workflow on your machine in docker,
driven by the same synthesizer, buildspec renderer, decider and step shim the
cloud uses. The verb split is absolute: `run` is always local, `dispatch` is
always cloud — there is no `--local` flag to forget.

## Prerequisites

- **A container runtime exposing the `docker` CLI.** The executor shells out to
  `docker run` / `docker stop` and preflights with
  `docker info --format '{{.ServerVersion}}'`; a daemon that does not answer
  fails the run before any state is written. Podman works only if `docker` is a
  compatible shim on `$PATH` — nothing else is supported.
- **Node ≥ 20** (`engines` on every package). The definition is loaded and
  synthesized in-process; the watched repo needs no build step.
- **A git checkout with a HEAD commit.** Identity (repo, sha, ref) is derived
  from `git rev-parse HEAD`, `git status --porcelain` and
  `git remote get-url origin`. Without a HEAD the run refuses to start; without
  an `origin` remote the repo falls back to `local/<directory-name>`.
- **No AWS credentials.** A local run makes **zero AWS calls** — no SSM, no
  DynamoDB, no S3, no ECR auth. Image pulls go through your own docker config,
  so private images must already be pullable by your docker (`docker login`),
  and `millwright` never brokers registry credentials.
- **A built step-shim delivery.** `millwright run` bind-mounts the shim from
  `@copperbox/millwright-cdk`'s `dist/shim`, resolved by walking up
  `node_modules/@copperbox/millwright-cdk/dist/shim` from the CLI, plus the
  monorepo sibling path. **The CLI does not depend on `millwright-cdk`**, so in
  a watched repo that only installs `@copperbox/millwright-workflows` the shim
  is not present and the run fails with a message naming the remedy. Today that
  means building it from a millwright checkout
  (`npm run build:shim` in `packages/millwright-cdk`) and pointing at it:

```sh
export MILLWRIGHT_SHIM_DIR=/path/to/millwright/packages/millwright-cdk/dist/shim
```

## `synth` first

`millwright synth` is the cheapest gate: it loads `millwright/workflows.ts`
in-process, compiles it to the JSON run model, and touches neither AWS nor
docker. Run it on every definition edit.

```sh
millwright synth --pretty                  # model to stdout, diagnostics to stderr
millwright synth --out /tmp/model.json     # model to a file instead
```

It catches, before anything runs: a definition that does not default-export a
`WorkflowSet`; every synth-time guardrail and lint the synthesizer emits (warnings
are printed, errors abort with `Synth failed; no run model emitted.` and exit 1);
unparseable repo identity when there is no `--repo` and no usable `origin`; and
`hashFiles(...)` cache-key parts, which are hashed against the checkout here, so
the model carries final key strings.

Flags that let you simulate control-plane context without a deployment:

| Flag | Effect |
|---|---|
| `--entry <path>` | definition entry point (default `millwright/workflows.ts`) |
| `--repo <owner/name>` / `--commit <sha>` | override the git-derived identity |
| `--ref <name>` | short triggering ref name; enables ref-sensitive lints |
| `--poll-cadence <minutes>` | enables the cron-granularity lint |
| `--secrets-allowed-refs <patterns>` | fail-fast secrets lint (enforcement stays the decider's) |
| `--schema-ceiling <version>` | the control plane's supported `schemaVersion` |
| `--pretty` | pretty-print the JSON |

Exit code 1 on any synth failure, so it drops straight into a pre-commit hook.

## Running a workflow

```sh
millwright run ci                          # whole workflow, working tree
millwright run ci --job build              # one job
millwright run ci --job integration --with-deps
millwright run ci --clean                  # source = git archive HEAD
millwright run release --as-tag v9.9.9-test
millwright run deploy --input environment=staging --input dryRun=false
```

Full flag surface (`millwright run <workflow>`):

| Flag | Behavior |
|---|---|
| `--job <name>` | run exactly one job; its `consumes` are fed from the newest prior local run in which that producer SUCCEEDED and whose artifact directory still exists. No donor → hard error naming the producing job. |
| `--with-deps` | with `--job`, run the whole ancestor closure instead of reusing artifacts. |
| `--clean` | archive `git archive HEAD` instead of the working tree. |
| `--platform <p>` | passed through to `docker run --platform`, for exact-arch parity. |
| `--secrets-file <path>` | override `.millwright/secrets.env`. An explicit path that does not exist is an error. |
| `--input k=v` | repeatable; typed against the workflow's `Trigger.manual` declaration. |
| `--as-tag <tag>` | present the run as `refs/tags/<tag>` instead of the current branch. |
| `--parallel <n>` | max concurrent jobs; defaults to `os.availableParallelism()`. |
| `--entry <path>` | definition entry point (default `millwright/workflows.ts`). |

**Selecting jobs.** With `--job X` (no `--with-deps`) the decider sees only `X`
plus the producers of artifacts `X` consumes, seeded from prior runs and copied
into this run's `out/`; pure ordering edges to unselected jobs are dropped. With
`--with-deps` the ancestor subgraph is executed for real.

**Dispatch inputs.** For a workflow with `Trigger.manual`, the definition is
synthesized twice: once to read the declared inputs, then again with the typed
values, so input-dependent factories and defaults resolve exactly as a cloud
dispatch resolves them. Booleans must be literally `true`/`false`. A required
choice input with no default is prompted when stdin is a TTY, and is a hard
error otherwise (`pass --input name=<a|b>`). Passing `--input` to a workflow
with no manual trigger is an error.

**Exit code** is 0 only when the run lands `SUCCEEDED`.

## Parity with cloud

Verified against `packages/millwright-cli/src/local/` and spec §14.

| Concern | Cloud | Local | Verdict |
|---|---|---|---|
| Definition → run model | synth at the triggering commit, inside CodeBuild after a lockfile install | same synthesizer, in-process, sub-second | **same model** (install-fidelity gap accepted) |
| DAG order, retries, `skipIf`, SKIPPED, terminal states | `decide()` in the decider Lambda | the identical `decide()` in-process | **same code** |
| Job phases (unpack, cache restore, steps, artifact upload, cache save) | `buildspecForJob` → CodeBuild buildspec | `buildspecForJob` → a POSIX `sh` script reproducing CodeBuild's phase semantics | **same document** |
| Step status reporting | step shim → EventBridge → DynamoDB | same shim → `events/<job>.jsonl`, tailed into the state file | **same shim** |
| Job image | declared image on CodeBuild | declared image on your docker, host arch unless `--platform` | **same image** |
| Image pull / auth | job role + `--ecr-repos` config + ECR repository policy | your own docker config; millwright brokers nothing | delegated |
| Context env (`MILLWRIGHT_RUN_ID/JOB/SHA/REF`) | set by the dispatcher | set identically; dirty tree marks the sha `-dirty` | same contract |
| Source | clean checkout at the commit | working tree (tracked + untracked-not-ignored); `--clean` for HEAD | ≈, explicit |
| Secrets | SSM / Secrets Manager → env vars | `.millwright/secrets.env` → env vars | same env-var contract, different source |
| Artifacts | `s3://…/<run>/out/<job>/<artifact>/` | `.millwright/runs/local-N/out/<job>/<artifact>/` | same layout |
| Dependency cache | S3, keyed | `.millwright/cache/`, same keys, persists across runs | same semantics |
| `timeoutMinutes` | CodeBuild timeout | timer → `docker stop` → `TIMED_OUT` | enforced both |
| `privileged: true` | dind in the runner image | host docker socket bind-mounted, with a printed fidelity note | **differs** |
| Cancellation | `runs cancel` writes `cancelRequested` | Ctrl-C sets `cancelRequested` through the same decider path | same path |
| IAM / job roles | per-job least privilege | none — no AWS calls at all | **absent by design** |
| `Compute.*` size and arch | honored (compute type, ARM/x86 container) | ignored; `--platform` is the only arch knob | advisory |
| Concurrency groups | enforced by the decider | carried in the model, **not enforced** | **differs** |
| Trigger predicates (push/PR/cron matching) | evaluated by the poller | **never evaluated** — you named the workflow, it runs | **unavailable** |
| GitHub checks / commit statuses | one check per job plus a synth check | **never reported**; `runs show` prints "local run — never reported to GitHub" | **unavailable** |
| Run identity | `ci#142`, in `runs list` | `local-N`, monotonic per clone, never in `runs list` | separate namespaces |
| CloudWatch logs / `millwright logs` | tail and dump from CloudWatch | **unavailable** — logs stream to your terminal only | **unavailable** |
| `runs rerun` / `runs cancel` | supported | **unavailable** for local runs | **unavailable** |

There is no `--ref` on `run` (only `--as-tag`), no `MILLWRIGHT_TAG` env var in
either host, and no local re-run of a completed `local-N`: re-run the command.

## Secrets locally

Local runs never read SSM or Secrets Manager. Every secret a job declares is
satisfied from a `KEY=VALUE` file, keyed by the **env var name** the job
declares — not by the parameter name:

```sh
mkdir -p .millwright
cat > .millwright/secrets.env <<'EOF'
# KEY=VALUE, #-comments, optional surrounding quotes
NPM_TOKEN=npm_xxxxx
DATABASE_URL="postgres://localhost/dev"
EOF
```

`.millwright/` self-gitignores (an `.gitignore` containing `*` is written on
first run), so the file cannot be committed by accident — but it holds real
credentials, so prefer dev/scoped values over production ones.

Preflight is fail-closed: before any container starts, every declared secret env
var across the jobs about to execute must be present. Missing ones are listed
with their job and reference, and nothing runs. Names matching the reserved
prefixes (`MILLWRIGHT_`, `CODEBUILD_`, `AWS_`) are skipped, exactly as the cloud
renderer drops them. If the default file is absent and no job declares a secret,
the run proceeds normally.

The safe pattern: keep `.millwright/secrets.env` for the everyday loop, and use
`--secrets-file ~/.config/millwright/<repo>.env` when you want the values to
live outside the checkout entirely.

## Debugging a failing job

Logs stream inline, prefixed `[<job>] ` — the same prefixes `millwright logs -f`
uses in the cloud. The run trailer summarizes per-status counts, and every
artifact of the run is preserved on disk:

```
.millwright/
  runs/local-7.json              run/job/step state
  runs/local-7/
    in/     model.json, source.tar.gz     # exactly the cloud run prefix
    out/    <job>/<artifact>/…            # $MILLWRIGHT_OUT_URI
    work/   <job>/                        # bind-mounted as the container workdir
    events/ <job>.jsonl                   # raw step events
    scripts/<job>.sh                      # the rendered phase script
  cache/                                  # keyed dependency cache
```

```sh
millwright runs show local-7      # jobs, steps, skip reasons — reads the state file, no AWS
```

**Reproducing a step.** Containers run `--rm`, so there is nothing to `docker
exec` into after a failure; but `work/<job>/` holds the unpacked source and
`scripts/<job>.sh` holds the exact commands. Start an interactive shell against
the same mounts and step through it by hand:

```sh
docker run --rm -it \
  -v "$PWD/.millwright/runs/local-7/work/build:/millwright/workspace" \
  -v "$PWD/.millwright/runs/local-7/out:/millwright/out" \
  -v "$PWD/.millwright/cache:/millwright/cache" \
  --workdir /millwright/workspace \
  public.ecr.aws/docker/library/node:22 /bin/sh
```

While a job is still running you can attach to it directly — containers are
named `millwright-local-<N>-<job>-<attempt>`:

```sh
docker exec -it millwright-local-7-build-1 /bin/sh
```

Common failure modes:

| Symptom | Cause |
|---|---|
| `docker is required for local runs and its daemon did not answer` | preflight `docker info` failed — start the daemon. |
| `infrastructure fault — docker could not run the job` | docker CLI unspawnable (exit -1) or daemon refusal (exit 125). Mapped to `FAULT`, which the decider retries within the attempt cap — unlike a non-zero command exit, which is `FAILED` and never auto-retries. |
| `no step-shim delivery found for local runs` | build `dist/shim` or set `MILLWRIGHT_SHIM_DIR` (see Prerequisites). |
| `missing local secrets — nothing was run` | populate `.millwright/secrets.env`. |
| `… consumes X.artifact — no local artifacts found` | run the producer first, add `--with-deps`, or drop `--job`. |
| Job passes locally, fails in cloud | usually the source-mode gap. Re-run with `--clean`, which archives HEAD bit-for-bit as a cloud run sees it. |
| Job passes locally, fails in cloud on arch | host-native multi-arch resolution. Re-run with `--platform linux/arm64` (or your fleet's arch). |
| Phase behaves unexpectedly | `install` / `pre_build` failures abort immediately; a `build` failure skips the rest of `build` and clears `CODEBUILD_BUILD_SUCCEEDING` but still runs `post_build` — where the success-guarded artifact upload and cache save no-op. This is reproduced faithfully in `scripts/<job>.sh`. |

Ctrl-C is a real cancellation: it sets `cancelRequested`, stops in-flight
containers, and lands every job in a terminal state — the same states a cloud
`runs cancel` produces. A second Ctrl-C exits immediately with 130.

## The pre-push loop

```sh
millwright synth --pretty >/dev/null   # definition compiles, lints clean
millwright run ci --job build          # fastest inner loop; artifacts persist
millwright run ci --clean              # full DAG against HEAD, cloud-fidelity source
git push                               # the poller picks it up within ~30–90 s
```

Substitute `millwright run ci --clean --platform linux/arm64` when your
deployment's fleet arch differs from your laptop's. After pushing, watch the
cloud run with `millwright runs list` and `millwright logs -f`.

---

See also: [Authoring workflows](workflow-authoring.md) for the definition API,
and [Operating a deployment](operations.md) for the cloud side.
