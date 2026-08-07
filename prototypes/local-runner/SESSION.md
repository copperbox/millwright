# PROTOTYPE — local execution parity, annotated CLI session

Discussion artifact for wayfinder ticket "Local execution parity". Not a design
commitment. React to the *experience*; the mechanics sketch is in
[`runner-sketch.ts`](runner-sketch.ts).

**Premise on the table**: `millwright run` is *always local* — the verb split does the
work of a `--local` flag. `run` = here, `dispatch` = cloud. There is no way to
accidentally run in the wrong place.

```
millwright run <workflow>       # execute locally, right now, from this checkout
millwright dispatch <workflow>  # ask the deployed control plane for a real run
```

---

## 1. The basic loop — run CI without pushing

```console
$ millwright run ci
● synth        millwright/workflows.ts → 5 jobs (in-process, 0.4s)
● plan         build ─▶ integration
               test-node18 | test-node20 | test-node22   (parallel)

▶ build        public.ecr.aws/docker/library/node:22
  cache        restore npm-8f3a91… → hit (local cache, 112 MB)
  [build] $ npm ci
  [build] added 312 packages in 4.1s
  [build] $ npm test
  [build] 47 passing (2.3s)
  [build] $ npm run build
  artifacts    dist → .millwright/runs/local-7/build/dist (3.2 MB)
✔ build        52s

▶ integration  (consumes build.dist)
▶ test-node18  ▶ test-node20  ▶ test-node22          # decider fires all ready jobs
  …interleaved logs, same [job] prefixes as `millwright logs -f`…
✔ integration  31s   ✔ test-node18  40s   ✔ test-node20  38s   ✔ test-node22  41s

Run local-7 SUCCEEDED in 1m 44s   (5 jobs: 5 ✔)
```

Annotations:

- **Synth runs in-process** (esbuild the TS directly) — sub-second feedback, not a
  container round-trip. Fidelity gap accepted: cloud synth runs `npm ci` + synth in
  CodeBuild; local trusts your checkout's node_modules.
- **Same decider, same DAG.** The in-process decider from the orchestration decision
  drives job order; `StartBuild` is swapped for `docker run` behind an executor
  interface. Parallel jobs actually run in parallel (bounded by `--parallel N`,
  default = CPU-ish).
- **Same images.** Each job runs in its declared container image via local docker.
  `Compute.ARM_SMALL`, `timeout` are *advisory locally* (timeout enforced, size
  ignored with a one-line note).
- **Same step shim.** Steps report start/end/status/SKIPPED through the same shim,
  writing to a local state file instead of DynamoDB — so the output format and
  SKIPPED semantics match the cloud tail exactly.
- **Local run ids** are `local-N`, monotonic per repo clone, stored under
  `.millwright/` (gitignored). They never mix with cloud run numbers (`ci#142`) and
  never appear in `millwright runs list`.

## 2. What executes: working tree by default

```console
$ millwright run ci
● source       working tree (12 files modified vs HEAD)  → copied into containers
```

- Default is the **working tree** — the whole point is feedback before commit/push.
  The tree is **copied** (git-aware: respects .gitignore, so no host node_modules
  leaks into a linux/arm container), not bind-mounted; each job gets a clean copy,
  like the cloud's per-job checkout.
- `--clean` runs from `git archive HEAD` — bit-for-bit what a cloud run at this
  commit would see. CI-debugging mode.

## 3. Fast feedback: one job, not the graph

```console
$ millwright run ci --job integration
● plan         integration   (consumes build.dist — reusing from local-7, 4m ago)
▶ integration  …
✔ integration  29s
```

- `--job X` runs exactly that job. Its `consumes` are satisfied from the **most
  recent local run's artifacts**; if none exist, the error names the producing job:
  `integration consumes build.dist — no local artifacts found; run
  'millwright run ci --job build' first or drop --job`.
- `--job X --with-deps` runs the ancestor subgraph instead of reusing.

## 4. Secrets: local .env, hard gate, no SSM

```console
$ millwright run release
✖ release/publish declares 2 secrets not present in your local env:
    NPM_TOKEN   (Secret.named('npm-token'))
    DOCKERHUB   (Secrets Manager passthrough)
  Provide them in .millwright/secrets.env (gitignored) or --secrets-file <path>.
  Local runs never read SSM/Secrets Manager.
```

- Same env-var contract as the cloud injection; values come from a gitignored env
  file. **The local runner has no AWS credentials and makes no AWS calls** — parity
  stops at the env-var boundary, exactly as the secrets decision radiated.
- Missing secrets fail *before* any job starts, naming what's needed.

## 5. Ctrl-C is a real cancellation

```console
▶ build  ▶ test-node20
^C
● cancel       stopping 2 running jobs…
✖ build        CANCELLED at step 2/3   ✖ test-node20  CANCELLED
○ integration  SKIPPED (upstream cancelled)
Run local-8 CANCELLED
```

- Ctrl-C sets the same `cancelRequested` flag through the same decider path as
  `millwright runs cancel` in the cloud — the terminal states you see locally are
  the ones you'd see there.

## 6. Manual workflows: typed inputs at the prompt

```console
$ millwright run db-migrate
? environment  (choices) › staging
? dryRun       (boolean) › true
▶ migrate      npx migrate --dry-run --env staging
```

- Interactive prompt from the synthesized input schema; `--input environment=prod
  --input dryRun=false` for non-interactive. Same typed values the cloud dispatch
  path passes to `steps: (inputs) => …`.

## 7. Event context: synthesized from the checkout

- Trigger predicates are **not evaluated locally** — you named the workflow, it runs.
- Context env vars (`MILLWRIGHT_REF`, `MILLWRIGHT_SHA`, `MILLWRIGHT_TAG`, …) are
  synthesized from the local checkout (current branch, HEAD sha; dirty tree marks
  sha `-dirty`). `--ref`-shaped overrides exist for faking a tag:
  `millwright run release --as-tag v9.9.9-test`.

## 8. Privileged jobs

- `privileged: true` jobs get the host docker socket mounted (`docker` works inside
  the job). Fidelity gap vs CodeBuild's real dind is accepted and printed as a
  one-line warning. No nested-VM heroics in v1.

---

## The parity contract (the table to argue with)

| | Cloud run | Local run | Parity |
|---|---|---|---|
| Definition + synth output | synth at triggering commit | same code, in-process synth | **same model** |
| Job order / retries / skips | decider Lambda | same decider, in-process | **same code** |
| Step status + SKIPPED | shim → DynamoDB | same shim → local state file | **same code** |
| Job environment | CodeBuild + declared image | local docker, same image | **same image** |
| Source | clean checkout at commit | working tree copy (`--clean` for commit) | ≈, explicit |
| Secrets | SSM/SM → env vars | secrets.env → env vars | same contract |
| Artifacts | S3 `<repo>/<run>/<job>/<name>` | `.millwright/runs/<id>/<job>/<name>` | same layout |
| Dependency cache | S3 keyed | local dir, same keys | same semantics |
| IAM / roles | per-job least privilege | none — no AWS calls at all | **absent, by design** |
| Compute size / fleet | `Compute.*` honored | ignored (noted) | advisory |
| Run identity | `ci#142`, `runs list` | `local-N`, invisible to cloud | separate namespaces |
