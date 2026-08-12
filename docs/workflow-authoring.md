# Authoring workflows

A watched repo describes its CI in TypeScript at `millwright/workflows.ts`, using
`@copperbox/millwright-workflows`. This page is the full authoring reference: every construct,
every option that exists today, and what each one turns into at run time. The [root
README](../README.md) covers operating millwright; this covers writing for it.

Millwright is early alpha. Where a capability you would expect from another CI system does not
exist yet, this document says so plainly rather than papering over it.

## File layout

```
millwright/
  workflows.ts        # default-exports a WorkflowSet
```

The entry point is `millwright/workflows.ts` by default (`millwright synth --entry <path>` to
point elsewhere). It must **default-export a `WorkflowSet`**; anything else is a hard error.
The file is loaded in-process — the watched repo needs no build step and no bundler, only the
one dependency:

```sh
npm install --save-dev @copperbox/millwright-workflows
```

The package has zero runtime dependencies and deliberately does not depend on `aws-cdk-lib`.
It is the only millwright package a watched repo installs.

## The object model

Three constructs, nested:

```ts
import { WorkflowSet, Workflow, Trigger } from '@copperbox/millwright-workflows';

const app = new WorkflowSet();                                   // the repo's whole definition
const ci = new Workflow(app, 'ci', { on: [Trigger.push()] });    // owns triggers + concurrency
ci.job('build', { image: '…', steps: ['npm ci'] });              // owns compute + steps

export default app;
```

- **`WorkflowSet`** — the root. `new WorkflowSet(defaults?)` where `defaults` is
  `{ image?, compute? }`. Holds `workflows`. Duplicate workflow names throw at construction.
- **`Workflow`** — `new Workflow(set, name, props)`. `props` is
  `{ on, concurrency?, image?, compute? }`. `on` must be a non-empty array of triggers or the
  constructor throws. Registering with the set is automatic — you never call `add`.
- **`Job`** — created by `workflow.job(name, props)`, which returns the `Job` so you can wire
  dependencies off it. A job belongs to exactly one workflow.

### From definition to run

1. An event (poll tick, cron minute, `millwright dispatch`) reaches the launcher.
2. The launcher matches the event against the **per-ref registry** — the `(triggers,
   concurrency)` map extracted from the last successful synth **for that ref**, falling back to
   the default branch's map for a ref never synthed. Consequence: a branch's own trigger and
   concurrency changes take effect from that branch's *second* run; a brand-new branch's first
   push is matched using default-branch config.
3. A matched run gets a workflow-scoped number (`ci#142`), gates through its concurrency group,
   then runs a **synth job**: clone at the triggering sha, install, synthesize, upload
   `model.json` and `source.tar.gz`.
4. The decider walks the job DAG from `model.json`, firing one CodeBuild build per ready job.

`model.json` — the run model — is the contract between your definition, the cloud
orchestration, and the local runner. It is also a privilege boundary: it is authored *inside*
the synth job, which executes your repo's code, so the control plane re-validates it and treats
every grant it requests as attacker-influenceable. That is why the secrets gate (below) lives
in the control plane and not in synth.

### Names

Workflow, job, and artifact names must match `/^[a-z0-9][a-z0-9._-]*$/i` — start with a letter
or digit, then letters, digits, `.`, `_`, `-`. The job name **`synth` is reserved** (it is a
control-plane check context) and throws. Duplicate job names within a workflow throw.

Each cloud run reports one check per job named `<workflow> / <job>`, plus a `<workflow> /
synth` check for the run itself, so names are user-visible in branch protection.

### The defaults cascade

`image` and `compute` resolve **job → Workflow → WorkflowSet**:

```ts
const app = new WorkflowSet({ image: 'public.ecr.aws/docker/library/node:22' });
const ci = new Workflow(app, 'ci', { on: [Trigger.push()], compute: Compute.ARM_MEDIUM });
ci.job('build', { steps: ['npm ci'] });                     // node:22, ARM_MEDIUM
ci.job('lint', { compute: Compute.ARM_SMALL, steps: ['npm run lint'] });
```

`image` has **no built-in default** — if a job resolves to nothing, synth fails. `compute`
falls back to `Compute.ARM_SMALL`.

## Triggers

`Workflow`'s `on` array. Five factories, all on the `Trigger` class.

### `Trigger.push(options?)`

```ts
Trigger.push()                              // every branch
Trigger.push({ branches: ['main', 'release/*'] })
```

Only option is `branches` — an array of ref patterns. Omit it and every branch matches. Rides
the resilient tier-1 poller (git protocol over SSH), so it works even when GitHub's REST API is
degraded. Both "new branch created at sha" and "existing branch moved to sha" satisfy a push
trigger.

There is **no `paths` filter** — millwright cannot skip a run based on which files changed. Do
path gating inside the job with `Step.run(cmd, { skipIf: … })`.

### `Trigger.tag(options)`

```ts
Trigger.tag({ pattern: 'v*' })
```

`pattern` is required and throws if empty. One pattern per trigger; use several `Trigger.tag`
entries for several shapes. Also tier-1.

### `Trigger.pullRequest()`

```ts
Trigger.pullRequest()
```

No options at all — no branch, label, or draft filtering. PR runs ride **tier-2 REST polling**,
which is explicitly best-effort and degrades before push/tag polling does. Two repo-level
switches govern it, both set by the operator, not the definition: `millwright repo update
--no-pr-polling` disables PR runs for the repo, and `--fork-prs on|off` (default **off**)
decides whether fork-authored PRs run at all.

A PR run's ref identity is `refs/pull/N`, which is why **PR runs never receive secrets** — see
[Secrets](#secrets).

### `Trigger.cron(expression)`

```ts
Trigger.cron('0 3 * * *')      // 03:00 UTC daily
```

Standard five fields (minute hour day-of-month month day-of-week), **evaluated in UTC**. There
is no timezone option. A malformed expression fails synth (`invalid-cron`).

Cron is **ref-less**: entries are read from the repo's default-branch registry entry and always
run the default-branch head. The poller tick doubles as the cron clock, so granularity degrades
to the deployment's `pollCadence`, and after a poller outage each entry catches up with exactly
one run. The [README's cron section](../README.md#cron-and-manual-dispatch) has the full
treatment; synth warns (`cron-finer-than-poll-cadence`) when it can see the cadence.

### `Trigger.manual(options?)`

```ts
Trigger.manual({
  inputs: {
    environment: { choices: ['staging', 'production'], default: 'staging' },
    dryRun: { type: 'boolean', default: true },
  },
})
```

Inputs are typed and come in exactly two shapes:

| shape | declaration | default behaviour |
| --- | --- | --- |
| choice | `{ choices: [...], default? }` | a default not in `choices` fails synth; with no default, dispatch **must** supply a value |
| boolean | `{ type: 'boolean', default? }` | defaults to `false` when `default` is omitted |

There are no string, number, or free-text inputs. Dispatch with:

```sh
millwright dispatch deploy --ref release/1.2 --input environment=production --input dryRun=false
```

`--ref` defaults to the default-branch head and is resolved to a sha before the event is
emitted, pinning definition and source together. Inputs are validated at synth against the
declaration: unknown names, wrong types, and out-of-range choices are all errors.

Inputs reach your definition through the **steps factory** form (see [Steps](#steps)).
Dispatching a workflow that has no `Trigger.manual` is an error (`not-manually-dispatchable`).

### Pattern dialect

`branches` and tag `pattern` use the same matcher as `secretsAllowedRefs`: patterns match the
**short ref name** (`main`, `release/1.2`, `v1.4.0`), **anchored at both ends**, with `*` as
the only metacharacter — and `*` crosses `/`. So `main` matches exactly `main`, never
`mainline`; `release/*` matches `release/1.2` and `release/a/b`. No `?`, no character classes,
no negation.

## Jobs

```ts
const build = ci.job('build', {
  image: 'public.ecr.aws/docker/library/node:22',
  compute: Compute.ARM_MEDIUM,
  privileged: false,
  timeout: { minutes: 20 },
  steps: ['npm ci', 'npm run build'],
  produces: { dist: Artifact.dir('dist') },
  cache: Cache.keyed({ key: ['npm-', hashFiles('package-lock.json')], paths: ['~/.npm'] }),
});
```

### `image`

A plain `docker run` image string. **Required** (via the cascade); no default. The contract on
the image is Linux plus a POSIX shell and nothing more — images are never millwright-aware, and
git and node are *not* required. Pin by tag; millwright publishes no images of its own.

Synth lints (`implicit-docker-hub`) any image that does not name an explicit registry host —
`node:22` and `myorg/app:1` are implicit Docker Hub references, which are rate-limited and
mutable. Prefer `public.ecr.aws/docker/library/node:22` or your own ECR. Synth makes no network
or registry calls, so this lint is purely string-level: it cannot tell you the tag doesn't
exist.

Pulling from a **private ECR** additionally requires the repo to be listed in the operator's
`millwright repo update --ecr-repos <arns>` allowlist *and* the ECR repository policy to permit
the job role. Neither is expressible in the definition.

### `compute`

`Compute.ARM_SMALL` (default), `ARM_MEDIUM`, `ARM_LARGE`, `X86_SMALL`, `X86_MEDIUM`,
`X86_LARGE`. ARM is the cheap path; x86 is the opt-in. These map to CodeBuild compute types on
on-demand EC2 — there is no reserved capacity, and no way to request a specific vCPU/RAM
combination outside the enum.

### `privileged`

`privileged: true` (default `false`) enables docker-in-docker. The contract is yours to hold:
**the image must contain docker**. `public.ecr.aws/docker/library/docker:<ver>-dind` is the
blessed choice. Millwright's prelude starts `dockerd` only when no live socket is already
present (which makes it a no-op locally, where the host socket is bind-mounted).

### `timeout`

`timeout: { minutes: N }` — a positive whole number, or synth fails (`invalid-timeout`). Not
set by default. Two other bounds exist but are **control-plane settings, not definition
options**: a per-job total-attempt cap (default 3) and a run-level wall-clock deadline
(default 24 h). You cannot set either from `workflows.ts` today.

### Steps

`steps` accepts either an array or a factory:

```ts
steps: ['npm ci', 'npm test']                              // plain strings

steps: [                                                    // Step.run for options
  'npm ci',
  Step.run('npm run test:e2e', { skipIf: 'test -z "$RUN_E2E"' }),
]

steps: (inputs) => [                                        // inputs-driven (Trigger.manual)
  'npm ci',
  `npm run deploy -- --env ${inputs.environment}`,
  ...(inputs.dryRun ? [] : ['npm run deploy:confirm']),
]
```

A job with zero steps is an error (`no-steps`); a factory that throws is an error
(`steps-factory-failed`). The factory receives declared input defaults, overlaid with the
dispatch values when *this* workflow is the one being dispatched — so a factory is evaluated
for push runs too, with defaults.

`skipIf` is a shell command evaluated before the step. **Exit 0 means skip**: the step reports
`SKIPPED` with `reason: skip_if` and the job continues. This is the only conditional mechanism
— there is no job-level `if`, no expression language, and no `continue-on-error`/soft-fail.

Steps run under `/bin/sh` in the unpacked source tree; there is no `workingDirectory` option —
`cd` in the step itself. There is also **no `env:` option** for ordinary (non-secret)
environment variables; set them inline in the step command. Env names beginning `MILLWRIGHT_`,
`CODEBUILD_`, or `AWS_` are reserved by the control plane and dropped if a definition tries to
claim them. Steps also have no display `name` in the authoring API yet — the run model carries
the command itself.

### The dependency graph

Two edge kinds, both taking **`Job` objects, not name strings** (there is no `needs:`):

```ts
const build = ci.job('build', { steps: [...], produces: { dist: Artifact.dir('dist') } });

ci.job('integration', {
  consumes: { dist: build.artifacts.dist },   // data edge — also an ordering edge
  steps: ['npm run test:integration'],
});

ci.job('notify', {
  dependsOn: [build],                          // pure ordering, no data
  steps: ['./scripts/notify.sh'],
});
```

`consumes` is the primary mechanism: consuming an artifact *is* the dependency. `dependsOn` is
for artifact-less ordering. Both are validated: an edge to a job outside the same workflow
fails (`consumes-unmatched` / `depends-on-unmatched`), a `consumes` with no matching `produces`
fails, and the combined graph must be **acyclic** or synth reports the cycle path.

Runtime semantics: jobs whose dependencies have all completed are dispatched immediately and in
parallel. Transitive dependents of a **failed** job go `SKIPPED` with `reason: upstream_failed`
while independent branches run to completion — there is no fail-fast in v1. The run is
`SUCCEEDED` only if every job succeeded or was skipped via a guard.

There is **no matrix DSL** — a matrix is a loop in TypeScript, since each job is an independent
build:

```ts
for (const node of ['20', '22']) {
  ci.job(`test-node-${node}`, {
    image: `public.ecr.aws/docker/library/node:${node}`,
    steps: ['npm ci', 'npm test'],
  });
}
```

Reuse across repos is npm packages: export functions that take a `Workflow` and add jobs.

## Artifacts

Declare what a job produces; consume it by reference elsewhere.

```ts
const build = ci.job('build', {
  steps: ['npm run build'],
  produces: {
    dist: Artifact.dir('dist'),
    report: Artifact.file('coverage/lcov.info'),
  },
});

ci.job('publish', {
  consumes: { dist: build.artifacts.dist },
  steps: ['npm publish'],
});
```

`Artifact.dir(path)` uploads a directory recursively; `Artifact.file(path)` a single file. Each
declaration takes exactly one path — for several paths, declare several artifacts. Paths are
workspace-relative. The record key is the artifact name and must be a valid name; duplicates
within a job fail validation. The key on `consumes` is arbitrary — only the `ArtifactRef` it
points at matters.

At run time, an artifact is uploaded to `runs/<repo>/<workflow>/<n>/out/<job>/<name>/` in the
deployment's bucket, and each job's IAM role can write **only its own `out/<job>/` subtree** —
so a compromised job can poison its own declared outputs and nothing else. Consumers fetch them
back to the same workspace-relative paths before their steps run. Upload happens after the
steps and only if the job is still succeeding.

Retention is a deployment-level S3 lifecycle rule, not a per-artifact option: `runs/` expires
after the deployment's `retention.artifacts` (which itself defaults to `retention.metadata`,
90 days). There is no per-workflow or per-artifact retention override.

## Caching

```ts
import { Cache, hashFiles } from '@copperbox/millwright-workflows';

cache: Cache.keyed({
  key: ['npm-', hashFiles('package-lock.json')],
  paths: ['~/.npm'],
  restoreKeys: ['npm-'],
})
```

GitHub-Actions semantics, with one important difference: **`hashFiles(...)` is resolved at
synth**, against the checked-out source, so `model.json` carries the final key string. Patterns
are workspace-relative globs where `*` and `?` stay inside a path segment and `**` crosses
segments; the matched set is sorted and folded — path and content both — into one SHA-256.

- `key` — a string, a `hashFiles()` token, or an array of both, concatenated. Required.
- `paths` — at least one path, or `Cache.keyed` throws.
- `restoreKeys` — prefix fallbacks tried in order on an exact-key miss. Default `[]`.

An exact-key hit **skips the save phase**. Save, like artifact upload, only runs if the job is
succeeding. One cache per job.

Two rules that bite:

- **Always give the key a literal part.** `hashFiles` resolves to the empty string when it
  matches nothing, and a key that resolves entirely empty fails synth (`cache-key-empty`) —
  which is the good outcome, but only because the literal makes the failure a typo rather than
  a silent collision.
- The resolved key becomes one S3 object name under `cache/<repo>/`, so keys and restore keys
  may not contain `/` or `..` (`cache-key-invalid`, `restore-key-invalid`).

Cache trust is repo-scoped: any job in the repo can write any of the repo's cache keys. Caches
expire on their own lifecycle rule (default 14 days). Docker layer caching is outside this
system in v1 — use `buildx` with an ECR or S3 backend inside a privileged job.

## Secrets

A job names the environment variables it wants and where their values come from:

```ts
ci.job('publish', {
  steps: ['npm publish'],
  secrets: {
    NPM_TOKEN: Secret.named('npm-token'),
    SHARED_KEY: Secret.named('signing-key', { scope: 'acme/platform' }),
    DB_URL: Secret.fromSecretsManager('arn:aws:secretsmanager:us-east-1:1234:secret:db-abc123'),
  },
});
```

The record key is the env var name the value lands in.

- **`Secret.named(name, { scope? })`** — a millwright-managed secret, resolved at dispatch from
  `/millwright/<deployment>/secrets/<scope>/<name>` in SSM Parameter Store. **Scope defaults to
  the repo the run belongs to.** Pass an explicit `scope` for a secret deliberately shared
  across repos; there is no ambient cross-repo sharing. Write values with
  `millwright secrets set <name> [--scope <scope>]` (the value is prompted, never echoed).
- **`Secret.fromSecretsManager(arn)`** — a passthrough reference to an existing Secrets Manager
  secret. Must start with `arn:` or it throws.

Values arrive as environment variables before the first step, resolved by the build agent, with
log masking. Two honest limits: masking is **exact-match only**, so a step that base64s,
substrings, or re-encodes a secret before printing it leaks the transformed value (synth always
warns about this — `secret-masking-exact-match`); and file-shaped secrets are not a thing yet,
so write the env var to disk in a step if you need one.

### The `secretsAllowedRefs` gate

**Declaring a secret does not grant it.** Which refs actually receive secrets is *repo
configuration*, set by the operator and enforced by the control plane:

```sh
millwright repo update acme/api --secrets-refs 'main,release/*'
```

The mechanism: each `(repo, workflow, job)` has two stable IAM role variants — one with the
declared secret grants and one with none. At dispatch, the decider picks the variant by
matching the run's ref against `secretsAllowedRefs`. A job that runs under the no-grants
variant simply cannot read the parameter; the reference fails closed on a missing grant.

Why the boundary is drawn here and not in synth: synth executes repo-controlled code. Anything
checked inside the synth job is checked by code an attacker with push access already controls.
The package's synth-time check (`secrets-ref-not-allowed`, emitted only when the CLI is given
both `--ref` and `--secrets-allowed-refs`) is **fail-fast UX**, never enforcement.

Configuring it correctly:

- **Default is unset, which means no ref receives secrets.** The shortest onboarding command is
  the safe one; opt in deliberately.
- Patterns use the dialect above: short ref name, anchored both ends, `*` the only
  metacharacter and it crosses `/`.
- **PR runs are structurally unmatchable.** A PR run's identity is `refs/pull/N`, which is not a
  short name and can never match a pattern. "No secrets on PR runs" is a rule, not an accident —
  do not try to work around it.
- **The honest limit, which you must design around:** an allowlisted ref *name* is only as
  strong as the GitHub-side protection of that namespace. `--secrets-refs 'release/*'` hands
  your secrets to anyone who can push a branch called `release/anything`. Lock the namespace
  down with a ruleset or branch protection *first*. `millwright doctor` warns where it can read
  ruleset state, but the protection itself is yours to configure.

Locally, `millwright run` reads secrets from the gitignored `.millwright/secrets.env` (or
`--secrets-file`) as `KEY=VALUE` lines keyed by the declared env var. It never touches SSM or
Secrets Manager, and it fails before any job starts if a declared secret is missing.

## Concurrency and cancellation

Declared per workflow:

```ts
new Workflow(app, 'deploy', {
  on: [Trigger.push({ branches: ['main'] })],
  concurrency: { group: 'deploy-${repo}', policy: 'supersede' },
});
```

- **`group`** — a static string with launcher-evaluable tokens: `${repo}`, `${ref}`,
  `${workflow}`, `${event}`. Any other `${...}` token is left unsubstituted and warns at synth
  (`unknown-concurrency-token`). Group scope is **deployment-global**, so two workflows in two
  repos that resolve to the same key contend with each other — include `${repo}` unless you
  mean that.
- **`policy`** — `'queue'` or `'supersede'`. Both are required; there is no default in the
  props type (the run model's own default is `queue`).

The mechanism is a slot pair per group: one running run, one pending. Under `queue`, a new run
is marked `QUEUED` in place and takes the pending slot; a third run **replaces** the pending
one, and the replaced run is `CANCELLED` with `reason: superseded`. Under `supersede`, the new
run cancels the running one. Superseded runs are rerunnable. Gating is uniform across push,
cron, dispatch, and rerun — there is no bypass flag. Local runs carry concurrency groups but do
not enforce them.

Cancellation is decider input, not an outside kill: `millwright runs cancel <run>` sets a flag
the decider reads, which stops in-flight builds, marks non-terminal jobs `CANCELLED`, and lands
the run terminal with checks reported. Local `Ctrl-C` goes through the same path. Nothing in
the definition controls cancellation.

`millwright runs rerun <run> [--failed]` re-executes from the **stored** model — it does not
re-synth, so a rerun reproduces the original definition even if the branch has moved.

## Synth

```sh
npx millwright synth                     # model to stdout, diagnostics to stderr
npx millwright synth --pretty --out model.json
```

`millwright synth` loads `millwright/workflows.ts` in-process, compiles the `WorkflowSet` to the
run model, and prints it. Repo identity comes from the `origin` remote and the commit from git
`HEAD` unless overridden. Flags:

| flag | effect |
| --- | --- |
| `--entry <path>` | definition file (default `millwright/workflows.ts`) |
| `--repo <owner/name>` | override the git-derived repo identity |
| `--commit <sha>` | override the git-derived commit |
| `--ref <name>` | short ref name; enables the `secretsAllowedRefs` fail-fast lint |
| `--out <file>` | write the model to a file instead of stdout |
| `--pretty` | pretty-print the JSON |
| `--schema-ceiling <n>` | the control plane's supported `schemaVersion` (cloud synth passes it) |
| `--poll-cadence <minutes>` | enables the cron granularity lint |
| `--secrets-allowed-refs <patterns>` | comma-separated; fail-fast lint only |

### Reading the output

Diagnostics go to stderr as `level[code] [workflow/job] message`:

```
warning[implicit-docker-hub] [ci/build] image "node:22" is an implicit Docker Hub reference …
error[image-unresolved] [ci/lint] job "lint" has no image: millwright has no default …
Synth failed; no run model emitted.
```

Warnings are advisory and exit 0. Any error exits 1 with **no model emitted** — synth is
all-or-nothing, and it reports every error it found rather than stopping at the first.
Validation runs in two passes: construction-level checks first, then full run-model schema
validation (reported with `invalid-model` and a JSON path like
`workflows[0].jobs[2].cache.key`), skipped when construction already failed so you aren't shown
the same problem twice.

**Errors:** `image-unresolved`, `no-steps`, `steps-factory-failed`, `invalid-timeout`,
`invalid-cron`, `consumes-unmatched`, `depends-on-unmatched` (and, via validation, a `consumes`
with no matching `produces`, and dependency cycles), `cache-key-empty`, `cache-key-invalid`,
`restore-key-invalid`, `hash-files-unresolvable`, `invalid-input-default`, `invalid-input-value`,
`unknown-input`, `missing-input`, `not-manually-dispatchable`, `unknown-dispatch-workflow`,
`invalid-repo`, `invalid-commit`, `schema-version-skew`, plus name-shape, duplicate-name, and
reserved-name violations (the last three also throw at construction time).

**Lints:** `implicit-docker-hub`, `secret-masking-exact-match`, `unknown-concurrency-token`,
`cron-finer-than-poll-cadence`, `secrets-ref-not-allowed`.

Synth makes **no network or registry calls**. It cannot tell you an image tag doesn't exist, a
secret isn't set, or a cache path is wrong.

### Keeping synth green

Broken `workflows.ts` doesn't fail silently — every cloud run reports a `<workflow> / synth`
check created `in_progress` at run start, which fails with the synth error in its summary. Add
those contexts to branch protection (not `millwright / synth`, which only bootstrap executions
report).

Locally, treat synth as a lint: run `npx millwright synth --out /dev/null` in a pre-commit hook
or as a job in the workflow itself. `--ref` plus `--secrets-allowed-refs` matching your repo
config turns the secrets gate into a local check too. And `millwright run <workflow>` executes
the whole thing locally against docker — same synth, same buildspec renderer, same decider — so
a definition that runs locally is a definition that synths.

## A worked example

Build, test in parallel, deploy on `main` — with a dependency graph, a cache, an artifact, and
a gated secret.

```ts
import {
  Artifact,
  Cache,
  Compute,
  Secret,
  Step,
  Trigger,
  Workflow,
  WorkflowSet,
  hashFiles,
} from '@copperbox/millwright-workflows';

// Repo-wide defaults. `image` has no built-in default, so setting it here means
// individual jobs only override when they actually need a different toolchain.
const app = new WorkflowSet({
  image: 'public.ecr.aws/docker/library/node:22',   // explicit registry: no Docker Hub lint
  compute: Compute.ARM_SMALL,
});

const ci = new Workflow(app, 'ci', {
  on: [
    Trigger.push({ branches: ['main'] }),
    Trigger.pullRequest(),                          // best-effort tier; never receives secrets
  ],
  // Deployment-global scope, so ${repo} and ${workflow} keep this key from colliding
  // with another repo's. supersede: a newer push cancels the in-flight run.
  concurrency: { group: 'ci-${repo}-${ref}', policy: 'supersede' },
});

const build = ci.job('build', {
  compute: Compute.ARM_MEDIUM,                      // overrides the WorkflowSet default
  timeout: { minutes: 20 },
  // Literal prefix + hashFiles: the hash resolves at synth against this commit's
  // lockfile, and the literal keeps the key usable if the lockfile ever vanishes.
  cache: Cache.keyed({
    key: ['npm-', hashFiles('package-lock.json')],
    paths: ['~/.npm'],
    restoreKeys: ['npm-'],                          // prefix fallback on an exact miss
  }),
  steps: ['npm ci', 'npm run build'],
  // Uploaded to out/build/dist/ after the steps, only if the job is succeeding.
  produces: { dist: Artifact.dir('dist') },
});

// `unit` and `integration` both depend on `build` and therefore run in parallel
// with each other as soon as it finishes.
ci.job('unit', {
  dependsOn: [build],                               // ordering only — needs no artifact
  steps: ['npm ci', 'npm test -- --coverage'],
});

ci.job('integration', {
  // Consuming the artifact IS the dependency edge; dist/ is restored to the same
  // workspace-relative path before these steps run.
  consumes: { dist: build.artifacts.dist },
  steps: [
    'npm ci',
    // skipIf exits 0 to skip: the step reports SKIPPED and the job continues.
    // This is the only conditional millwright has.
    Step.run('npm run test:integration', { skipIf: 'test ! -d integration' }),
  ],
});

const deploy = new Workflow(app, 'deploy', {
  on: [
    Trigger.push({ branches: ['main'] }),
    Trigger.manual({
      inputs: {
        environment: { choices: ['staging', 'production'], default: 'staging' },
        dryRun: { type: 'boolean', default: true },  // booleans default false if omitted
      },
    }),
  ],
  // queue, not supersede: never cancel a deploy mid-flight. A third run replaces
  // the pending one (CANCELLED, reason: superseded) rather than piling up.
  concurrency: { group: 'deploy-${repo}', policy: 'queue' },
});

deploy.job('ship', {
  timeout: { minutes: 30 },
  // Resolves at dispatch from /millwright/<deployment>/secrets/<this repo>/deploy-token.
  // It only actually arrives if the run's ref matches the repo's secretsAllowedRefs
  // (`millwright repo update --secrets-refs main`); on a PR run it never can.
  secrets: { DEPLOY_TOKEN: Secret.named('deploy-token') },
  // Factory form: sees declared defaults on push runs, dispatch values on dispatch.
  steps: (inputs) => [
    'npm ci',
    'npm run build',
    `./scripts/deploy.sh --env ${inputs.environment}${inputs.dryRun ? ' --dry-run' : ''}`,
  ],
});

export default app;
```

Two things worth restating about that `deploy` workflow. First, `ship` declares
`DEPLOY_TOKEN` but that declaration grants nothing — the operator must run
`millwright repo update <repo> --secrets-refs main` *and* protect the `main` namespace on
GitHub, or the job runs under the no-grants role variant and the reference fails closed.
Second, the push trigger and the manual trigger share the workflow, so a push to `main` runs
`ship` with `environment: 'staging'` and `dryRun: true` — the declared defaults. If that isn't
what you want, split it into two workflows.

---

See also: [Running workflows locally](local-execution.md) to test a definition
before pushing, and [Operating a deployment](operations.md) once it does.
