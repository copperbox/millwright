# Deploying millwright

A millwright deployment is one CDK stack in one AWS account and region, plus a
GitHub App (or PAT) and a per-repo deploy key that the CLI writes into SSM after
the stack is up. This guide walks that chain end to end.

> millwright has never been deployed to a real account. Everything below is
> traced to source, but no step here has been exercised against live AWS or
> GitHub. Expect to hit rough edges and treat the first deploy as a shakedown.

## 1. Prerequisites

**Node.** `>=20` (`engines` on every package). The cloud synth job runs on
`node:22` pinned by digest, but your machine only needs 20+.

**AWS account, bootstrapped.** The construct stages S3 assets — bundled Lambda
handlers, the synth-job bundle, the step-shim delivery — so the target
account+region must have been `cdk bootstrap`ed. Deploying needs credentials
that can create IAM roles, a KMS key, DynamoDB tables, an S3 bucket, Lambda
functions, a Step Functions state machine, a CodeBuild project, an EventBridge
bus and schedule, and CloudWatch alarms. No Docker is required: Lambda handlers
are bundled with esbuild (a normal dependency of the CDK package) and the shim
delivery stages locally.

**A permissions boundary.** `permissionsBoundary` is the construct's one
required prop and the only cap on the IAM that repo-editable workflow
definitions can request. Create the managed policy before you deploy; you need
its ARN. The construct throws at construct time if it is missing, so the failure
lands at `cdk synth` rather than in the account.

**Region.** Deployments are regional and discovery is account+region scoped, so
one region per deployment. The poller Lambda is deliberately non-VPC (SSH egress
through a NAT gateway would dominate the stack's cost), so no networking
prerequisites. The CLI reads `AWS_REGION` / `AWS_DEFAULT_REGION`.

**GitHub.** To create the App under an organization via `setup --org`, you need
owner rights in that org; without `--org` the App is created under your personal
account. Either way someone with admin on each watched repo has to install the
App on it. The App requests exactly: Contents read, Checks write, Commit
statuses write, Pull requests read, Administration write. Administration write is
what lets `repo add` install deploy keys unattended; it also means a stolen App
PEM can install an attacker's deploy key on every watched repo. If that blast
radius is unacceptable, use `setup --pat` (section 3).

**Day-2 CLI permissions.** millwright ships no operator IAM policy — AWS
credentials are the CLI's only auth, and your own identity policy has to cover
what it does: `ssm:GetParameter*`/`PutParameter`/`DeleteParameter` under
`/millwright/*`, `kms:Encrypt`/`Decrypt`/`GenerateDataKey` on the deployment CMK
(SecureStrings are two-gated behind SSM *and* the key), `events:PutEvents` on
`<deploymentName>-bus` (the bus resource policy permits `millwright.cli` events
from any non-system principal, but grants nothing itself), plus DynamoDB reads on
`<deploymentName>-state` and CloudWatch Logs reads for `runs`/`logs`.

## 2. Scaffold and deploy the control plane

```sh
npx @copperbox/millwright-cli init \
  --deployment-name millwright \
  --permissions-boundary arn:aws:iam::123456789012:policy/MillwrightBoundary
```

`init` takes an optional `[directory]` argument (default `.`) and refuses to
overwrite any existing file, so run it in an empty directory. It writes five
files: the CDK app proper is `app.ts` + `cdk.json` (`{"app": "npx ts-node
app.ts"}`); `package.json`, `tsconfig.json` and `.gitignore` are npm plumbing so
`npm install && npx cdk deploy` works unchanged. The generated `package.json`
pins `aws-cdk-lib` and the `aws-cdk` CLI at `^2.170.0` (the construct's own peer
floor is `^2.100.0`).

If you omit `--permissions-boundary`, `init` scaffolds `Boundary.NONE` with a
TODO comment and prints a warning. That deploys, but every job role is then
capped only by control-plane policy. Replace it before the stack matters.

The construct is a plain `Construct`, so composing it into an existing CDK app
instead of using the scaffold is the same three lines.

```ts
#!/usr/bin/env node
import { App, Duration, Stack } from 'aws-cdk-lib';
import { Millwright } from '@copperbox/millwright-cdk';

const app = new App();

// The scaffold omits `env`; setting it pins the account+region rather than
// resolving them at deploy time from ambient credentials.
const stack = new Stack(app, 'MillwrightStack', {
  env: { account: '123456789012', region: 'us-east-1' },
});

new Millwright(stack, 'Millwright', {
  // REQUIRED. Managed policy ARN, or the explicit `Boundary.NONE` sentinel
  // (which deploys without a boundary and emits a synth-time warning).
  permissionsBoundary: 'arn:aws:iam::123456789012:policy/MillwrightBoundary',

  // Namespaces the SSM config plane (/millwright/<name>/…) and every physical
  // resource name, so several deployments can share an account+region.
  // Must match /^[a-z][a-z0-9-]{0,62}$/.  Default: 'millwright'.
  deploymentName: 'millwright',

  // The poll tick. It is also the cron clock — there is no separate
  // scheduler — so anything over 1 minute degrades cron granularity to the
  // cadence, and the construct warns at synth.  Default: 1 minute.
  pollCadence: Duration.minutes(1),

  retention: {
    // CloudWatch build-log retention. Must be one of CloudWatch's supported
    // day counts or the construct throws.  Default: 30 days.
    logs: Duration.days(30),
    // Run/job metadata TTL on the state table (REG# registry rows are
    // exempt).  Default: 90 days.
    metadata: Duration.days(90),
    // S3 lifecycle expiry on the bucket's runs/ prefix.
    // Default: whatever `metadata` is — artifacts age out with their rows.
    artifacts: Duration.days(90),
    // S3 lifecycle expiry on the bucket's cache/ prefix.  Default: 14 days.
    cache: Duration.days(14),
  },
});
```

Those four (`permissionsBoundary`, `deploymentName`, `pollCadence`, `retention`)
are the entire prop surface. Then:

```sh
npm install
npx cdk deploy
```

The deploy creates, among the rest: DynamoDB `<name>-state` (streams + TTL) and
`<name>-polling`; S3 `<name>-artifacts-<account>-<region>` (auto-named instead if
the deployment name is long enough to blow S3's 63-char cap — the construct warns
and the manifest still records the real name); the KMS CMK aliased
`alias/millwright/<name>` with rotation on; log group `/millwright/<name>/builds`;
the `<name>-bus` event bus with its source-pinned resource policy; the
`<name>-builds` CodeBuild project; the `<name>-run-executor` state machine; the
launcher, poller, synth, post-synth, step-events-writer and sweep Lambdas; and
the SSM manifest at `/millwright/<name>/manifest` that everything downstream
discovers the deployment through.

Watch the synth output for two warnings worth acting on. `shimWithoutBinaries`
means the step-shim delivery carries only the node-on-PATH fallback bundle, and
jobs whose images lack node will fail at their first step — released npm builds
ship the prebuilt binaries, so this should only appear when deploying from a
source checkout without `npm run build:shim`. `noPermissionsBoundary` means you
are on `Boundary.NONE`.

## 3. `millwright setup`

```sh
millwright setup                 # GitHub App via the manifest flow
millwright setup --org acme      # …created under an organization
millwright setup --pat           # fine-grained-PAT mode instead
```

The default path runs GitHub's App manifest flow locally: the CLI starts an HTTP
server bound to `127.0.0.1` on an ephemeral port, prints the URL to open, and the
page auto-POSTs an App manifest to GitHub (`/settings/apps/new`, or
`/organizations/<org>/settings/apps/new` with `--org`). You approve in the
browser, GitHub redirects back to the local callback with a temporary code, and
the CLI exchanges it for the App id and private key PEM. The round-trip times out
after 10 minutes. App names are globally unique on GitHub; the default is
`millwright-<deploymentName>`, and `--app-name` is the escape hatch for
collisions. No webhook is configured — millwright polls.

`--pat` instead prompts (without echo) for a fine-grained PAT with contents
read, statuses write, administration write. PAT mode reports **commit statuses**
rather than check runs, using identical context names, so branch protection
requirements are unchanged either way.

Either way, credentials land as a SecureString under the deployment CMK at:

```
/millwright/<deploymentName>/github/app
```

`setup` refuses to run if that parameter already exists; `--force` replaces it.

Finally, `setup` fetches GitHub's `/meta` and pins the SSH host keys as a plain
String at `/millwright/<deploymentName>/github/host-keys`, one
`github.com <algo> <base64>` line per key. Every SSH exchange the poller, the
synth job and the CLI make is verified against those pins, which is why they are
seeded before any repo is onboarded. After a *confirmed* GitHub host-key
rotation, `millwright refresh-host-keys` re-pins from `/meta`; the poller honors
the new pins on its next tick, no redeploy.

In App mode, install the App on the repos you intend to watch before moving on —
`setup` prints the installation URL. `repo add` degrades to a manual deploy-key
paste without an installation, and `doctor`'s pulls probe fails outright.

## 4. `millwright repo add`

```sh
millwright repo add acme/api \
  --secrets-refs 'refs/heads/main,refs/tags/v*' \
  --fork-prs off \
  --ecr-repos arn:aws:ecr:us-east-1:123456789012:repository/base
```

In order, `repo add`:

1. Refuses if `/millwright/<name>/repos/<owner>/<repo>/config` already exists —
   use `repo update` for changes.
2. Loads the App/PAT credentials and the host-key pins, failing with "run
   millwright setup first" if either is missing.
3. Mints a fresh read-only Ed25519 deploy key and installs it on the repo via
   the API, titled `millwright/<deploymentName>`. On a 403/404 (App not
   installed, or GitHub refusing) it prints the public key, points you at
   `https://github.com/<owner>/<repo>/settings/keys`, and waits for Enter.
4. Writes the private key as a SecureString to
   `/millwright/<name>/repos/<owner>/<repo>/deploy-key` — **before** the config
   parameter, because the poller discovers repos by the config prefix and must
   never find a repo whose key is missing.
5. Verifies the key by an SSH `ls-refs` against the repo, resolving the
   default-branch head. Three attempts, 3 s apart, then a hard failure.
6. Writes the config parameter (`secretsAllowedRefs`, `prPolling`,
   `forkPrPolicy`, `ecrPullRepos`) and echoes the effective values.
7. Emits a `bootstrap` event (`source: millwright.cli`) onto `<name>-bus` for the
   default-branch head, which drives a synth-only run that primes the per-ref
   registry and reports a `millwright / synth` check.

Flags: `--secrets-refs <patterns>` (comma-separated; **default is none**, i.e. no
ref receives secrets), `--no-pr-polling`, `--fork-prs on|off` (default off),
`--ecr-repos <arns>`. `repo update` changes any of them and leaves unspecified
ones alone; `repo list` prints the current set.

Two benign exits: an empty repo prints that triggers activate on the first push,
and a repo reporting no default-branch symref skips the bootstrap event and
leaves the poller to prime the registry on its first tick.

Verify it took:

```sh
millwright repo list
millwright doctor
```

`doctor` re-runs the deploy-key `ls-refs`, probes pull-request read access, and
**fails** — not warns — if a configured repo shows polling activity but no
default-branch registry entry, naming the re-`repo add` remedy. On GitHub, the
commit at the default-branch head should pick up a `millwright / synth` check.

## 5. Verify the deployment

```sh
millwright doctor
```

This is the single command that walks the whole chain: manifest and resource
names, credential validity, host-key pins, per-repo deploy keys and pulls
probes, poller health, registry priming, CodeBuild and IAM quotas, ECR resource
policies, and branch rulesets covering `secretsAllowedRefs`. It exits non-zero
when any check is `[FAIL]`.

The poller line is the one to read first. The poller stamps `lastTickAt` (and
`lastTickDurationMs`) on the polling table's circuit-breaker item every tick, and
`doctor` reports:

- `[ ok ] poller: ticking — last tick 23s ago, last tick took 812 ms` — healthy.
- `[warn] poller: no poller tick recorded` — it has never run. Deploy may still
  be settling, or the scheduler/function is broken.
- `[FAIL] poller: last poller tick was 400s ago (cadence 60s)` — stopped. Check
  the poller Lambda's logs.
- `[FAIL] poller: quorum circuit breaker is OPEN` — SSH transport to GitHub is
  failing across repos.

Then land a first real run. Push to a watched repo's default branch (with a
`millwright/workflows.ts` present), or force one:

```sh
millwright dispatch ci --ref main
millwright runs list
millwright runs show ci#1
millwright logs ci#1 --follow
```

Success looks like: `runs list` showing the run, `runs show` listing jobs and
steps with a terminal `SUCCEEDED`, one `<workflow> / synth` check plus one
`<workflow> / <job>` check per job on the commit, and log streams under
`/millwright/<name>/builds`. First runs are slower than steady state — the synth
job clones and installs from scratch, and grant-changing runs of trusted refs
absorb a bounded (~60 s) IAM propagation wait.

## 6. Teardown

Do the GitHub-side cleanup *first*, while the credentials still exist:

```sh
millwright repo remove acme/api      # for each watched repo
npx cdk destroy
```

`repo remove` deletes the repo's config and deploy-key parameters and
best-effort deletes the deploy key from GitHub (matched by the
`millwright/<deploymentName>` title). If the delete fails it tells you which key
to remove by hand.

The construct sets no `removalPolicy` anywhere, so every resource takes its
aws-cdk-lib default. **`cdk destroy` therefore orphans, rather than deletes:**

- DynamoDB `<name>-state` and `<name>-polling`
- S3 `<name>-artifacts-<account>-<region>` and everything in it (there is no
  `autoDeleteObjects`, so a non-empty bucket could not be deleted regardless)
- the KMS CMK and its `alias/millwright/<name>` alias
- log group `/millwright/<name>/builds`

Delete those manually if you want them gone. The CMK needs a scheduled deletion
window (7–30 days), and once it is gone every remaining SecureString below is
permanently unreadable.

**Never CloudFormation-managed at all**, so untouched by `cdk destroy`:

- Every runtime-written SSM parameter — `/millwright/<name>/github/app`,
  `/github/host-keys`, `/repos/<owner>/<repo>/config`,
  `/repos/<owner>/<repo>/deploy-key`, `/secrets/<scope>/<name>`. Only the
  `manifest` parameter belongs to the stack (and, as a `StringParameter`, is
  deleted with it — which means the CLI can no longer discover the deployment
  even though its config plane survives).
- The stable job roles under the `mw-*` namespace. These are created at runtime
  by the decider's IAM reconciler, not by CloudFormation, and the 30-day
  orphan sweep that would normally reap them dies with the stack. Delete them by
  prefix.
- GitHub state: the App itself, its installations, and any deploy keys still on
  repos you did not `repo remove`.
- The CDK bootstrap stack and its staging bucket.

## 7. Multiple deployments

`deploymentName` namespaces both the SSM config plane (`/millwright/<name>/…`)
and every physical resource name, so several deployments can share one
account+region. The construct self-registers `/millwright/<name>/manifest`, and
the CLI discovers deployments by listing `/millwright` recursively and matching
manifest parameters.

Selection order, highest first:

1. `--deployment <name>` — a top-level flag, so it goes **before** the
   subcommand: `millwright --deployment prod repo add acme/api`.
2. `MILLWRIGHT_DEPLOYMENT=prod millwright doctor`.
3. Auto-discovery, but only when the account+region has exactly one deployment.

With several deployments and no selection, the CLI lists what it found and tells
you to pick one. With none, it says so and points at `init` + `cdk deploy` — the
message is careful that `MILLWRIGHT_DEPLOYMENT` and `--deployment` only select
among *visible* deployments, so an empty list usually means wrong credentials or
wrong region. No pointer file is ever committed to a watched repo.

---

Next: [Operating a deployment](operations.md) for day-two work, and
[Authoring workflows](workflow-authoring.md) for what the watched repos write.
