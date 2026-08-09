---
id: "013"
title: Runner image model
type: wayfinder:grilling
status: closed
assignee: dan
blocked-by: ["004"]
---

## Question

Jobs run as CodeBuild builds with a per-build `imageOverride` — so what's the v1 image
story? A default millwright job image (contents? maintained how?), custom images from
ECR/Docker Hub, toolchain setup (preinstalled vs setup-steps), and how the
workflow-definition API expresses the choice. Also: does millwright build/publish its
own base image as part of deployment? Blocked on
[Workflow-definition construct API](004-workflow-definition-api.md) for how it surfaces
in the API. Graduated from fog once CodeBuild was picked in
[Job compute runtime](001-job-compute-runtime.md).

Constraint radiated from [Local execution parity](007-local-execution-parity.md): the
local runner pulls job images through the user's own local docker daemon and config —
millwright does no registry auth or discovery itself. Default/blessed images should
therefore be **publicly pullable** so zero-setup local runs work; private images remain
possible via the user's own `docker login`.

## Resolution

Decided live with Dan (2026-08-08), grilled branch-by-branch.

- **Image contract: Linux + POSIX shell, nothing more.** The step shim is a **static
  binary injected at run time** — S3 secondary source in CodeBuild (the CodeBuild agent
  materializes sources regardless of image contents), bind-mount in the local runner.
  Images are never millwright-aware; git and node are not required in job images (jobs
  get source from the synth job's S3 package, not by cloning).
- **No default image; `image` is required.** Resolved via a **job > `Workflow` >
  `WorkflowSet` cascade**; synth fails with a clear error when a job resolves to
  nothing. Rationale: millwright can't know a team's toolchain, so any default is wrong
  for most jobs — AWS's curated images are multi-GB, only partially publicly pullable
  (Amazon Linux line only on ECR Public), and the provisioning spike showed no
  standard-vs-custom speed edge; a minimal base image fails confusingly the moment a
  step needs a toolchain.
- **Millwright publishes no images** — not at deploy time (nothing millwright-specific
  to bake; private ECR would break zero-setup local pulls), not as an OSS artifact
  (CVE/version/multi-arch treadmill vs already-well-maintained official images). Escape
  valve if dind pressure appears: **documented Dockerfile recipes**, never a published
  image.
- **Image is the toolchain: no runtime/setup DSL** (`runtime-versions`/`setup-node`
  style). Version pinning = image-tag pinning; matrices interpolate tags (already in
  the prototype); heavier needs = small custom image in the team's own ECR (cloud pulls
  via synthesized IAM; local via the user's own `docker login`, per 007's seam).
- **API surface**: `image` is a **plain string** with docker-run semantics (a construct
  earns nothing since millwright does no registry auth/discovery). **Synth lints are
  string-level only** — missing-image error, and a warning on implicit Docker Hub
  references (bare `node:22`) recommending the `public.ecr.aws/docker/library/...`
  mirror, since Hub rate limits from CodeBuild's shared egress IPs are a live
  production hazard. No registry/network calls at synth; arch mismatch (x86-only image
  on ARM default compute) surfaces as docker's own runtime error — accepted for v1.
  When the string parses as a **private-ECR URI, synth auto-grants pull permissions**
  on that job's materialized role.
- **Privileged jobs: documented contract that the image contains docker** (CLI +
  daemon); blessed zero-effort choice is the official
  `public.ecr.aws/docker/library/docker:<ver>-dind`. Synth can't verify (no registry
  calls) so it's contract, not lint. Millwright's **generated prelude auto-starts
  `dockerd`** when `privileged: true` and no docker socket is already live, then waits
  for the socket before step 1 — the socket-liveness guard makes the same prelude a
  no-op locally, where 007 mounts the host daemon's socket and the image only needs
  the CLI.

Asset: [`prototypes/workflow-api/workflows.ts`](../../prototypes/workflow-api/workflows.ts)
updated — the `release/publish` privileged job now uses a docker-capable custom-ECR
image instead of the broken `node:22` + `privileged` combination, and the `#013 TBD`
comment now states the decided rule.

**Constraints radiated**: the spec's build prelude owns dockerd startup and shim
delivery (S3 secondary source); the Docker-Hub-mirror lint joins the synth lint list
alongside 001's secret-masking lint.
