# @copperbox/millwright-cdk

The `Millwright` CDK construct: deploys the millwright control plane into your
AWS account. Compose it into an existing CDK app, or let `millwright init`
scaffold the minimal two-file app for you.

```ts
import { Millwright } from '@copperbox/millwright-cdk';

new Millwright(stack, 'Millwright', {
  deploymentName: 'millwright',      // default; namespaces SSM + resources
  permissionsBoundary: boundaryArn,  // REQUIRED (Boundary.NONE to opt out, with a warning)
  pollCadence: Duration.minutes(1),  // default
  retention: { logs: Duration.days(30), metadata: Duration.days(90) },
});
```

`permissionsBoundary` is the one required prop: it is the only cap on the IAM
that repo-editable workflow definitions can request. The construct throws at
construct time without it, so the failure surfaces at `cdk synth`.

The construct self-registers a deployment manifest at
`/millwright/<deploymentName>/manifest`, which the CLI uses for zero-config
discovery.

## The synth phase (spec §7.2)

Every run's first step is a **synth job**: a CodeBuild build on the single
`<deploymentName>-builds` project that clones the watched repo at the
triggering commit (deploy key, host keys pinned from SSM; PR runs add one
extra fetch of `+refs/pull/N/head` from the base repo's namespace), installs
dependencies by lockfile discovery, runs the control plane's own synth
tooling (an esbuild bundle delivered as a CDK S3 asset — never resolved from
the watched repo), and writes `model.json` + `source.tar.gz` to the run's
`in/` prefix. The image is the full `public.ecr.aws/docker/library/node:22`,
pinned by digest per release (`src/synth-image.ts`, refreshed with
`node scripts/pin-synth-image.mjs`).

The synth job executes repo-controlled code and is treated as a trust
boundary: its role (`<deploymentName>-synth-job`) reads deploy keys,
host-key pins and repo config, writes only `runs/*/in/*`, and has **no
DynamoDB access**. The registry entry the launcher matches events against is
written by the control-plane **post-synth step**
(`<deploymentName>-post-synth`), which re-reads `model.json` from S3,
schema-validates it, rejects models claiming a different repo or commit, and
only then writes `REG#<repo>` / `REF#<ref>` — plus the `<workflow> / synth`
(or, for bootstrap synth-only executions, `millwright / synth`) check
desired state.

## The shim data plane (spec §12, §11.2)

Job images carry "Linux + POSIX shell, nothing more", so all data-plane work
runs through the delivered shim binary. `src/runtime/shim/` implements the
subcommands the shared buildspec renderer authors:

- `source unpack` — extracts `source.tar.gz` (jobs never clone) with a
  dependency-free tar reader; path traversal in an archive is refused.
- `artifact upload` / `artifact fetch` — objects under
  `out/<job>/<artifact>/<workspace-relative-path>`. Upload derives its
  destination from the job's own dispatch identity (`MILLWRIGHT_JOB`); no
  invocation can name another job's subtree, and the job role's IAM policy
  (spec §10.2) enforces the same boundary underneath. Fetch may read any
  producer — run-wide artifact read is deliberate. Loose artifact objects do
  not carry file modes (v1 limit); caches, which travel as tar.gz, do.
- `cache restore` / `cache save` — exact key first, then `restoreKeys`
  prefixes in order (newest object wins); an exact hit drops a marker that
  makes the post-build save a no-op, and save also skips when the key
  already exists (cache write trust is repo-scoped — first writer wins).

The `MILLWRIGHT_OUT_URI`/`MILLWRIGHT_CACHE_URI` env vars carry `s3://` URIs
in the cloud and plain directory paths under the local runner; the commands
are identical in both.

Pinned physical names this construct honors or introduces:

| Name | What |
|---|---|
| `<deploymentName>-builds` | C11 — the single CodeBuild project (pinned by the run-executor issue, created here). |
| `<deploymentName>-synth` | Synth phase Lambda: starts the synth build, which completes the machine's task token via the synth-events completer. |
| `<deploymentName>-post-synth` | Post-synth validation/registry Lambda. |
| `<deploymentName>-synth-job` | The synth build's service role. |
| `<deploymentName>-run-executor` | The state machine (launcher-pinned) whose tokens the completer finishes. |
