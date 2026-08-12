---
type: architecture
title: Job execution environment
tags:
  - millwright
  - codebuild
  - docker
  - orchestration
timestamp: 2026-08-12T21:27:50.562Z
---

## Image model

The contract is **Linux + a POSIX shell, nothing more**. Consequences:

- **Images are never millwright-aware.** git and node are **not** required in *user job* images —
  the [synth job](synth-job.md) is the explicit exemption.
- **`image` is required**, with the job > Workflow > WorkflowSet cascade and **no default**; synth
  fails clearly when a job resolves to nothing.
- **Millwright publishes no images.** The image *is* the toolchain, so pinning means tag pinning by
  the user.
- `image` is a plain docker-run string; lints are string-level only.
- **Privileged jobs** carry the documented contract that the image contains docker — the blessed
  choice is `public.ecr.aws/docker/library/docker:<ver>-dind`.
- **Private-ECR images additionally require** the repo to appear in repo config's `ecrPullRepos`
  allowlist **and** the ECR repository resource policy to permit the job role. Both, not either.

## Generated buildspec

Rendered by the shared control-plane library — **repo code never authors the buildspec that wraps
it**. Per job:

1. **Prelude** — if `privileged: true` and no live docker socket, auto-start `dockerd` (the
   socket-liveness guard makes this a no-op locally).
2. Unpack `source.tar.gz` from `in/`.
3. **Shim delivery** via S3 secondary source (bind-mounted locally).
4. **Cache restore** — exact key, else `restoreKeys` prefix fallback (needs the prefix-conditioned
   `s3:ListBucket`, granted).
5. **Steps, shim-wrapped** — start/end/status/skip emitted as step events; `skipIf` → SKIPPED.
6. **Artifact upload** to `out/<job>/`, then cache save (skipped on an exact hit).

Secrets arrive **pre-step-1** via CodeBuild-native `env.parameter-store` / `env.secrets-manager`
blocks. See [Secrets gating](../security/secrets-gating.md).

## Compute

On-demand EC2. environmentType **`ARM_CONTAINER`**, computeType **`BUILD_GENERAL1_SMALL`** by
default; x86 opt-in maps to `LINUX_CONTAINER` via `environmentTypeOverride`.

**Reserved capacity is rejected — it violates zero-idle.** (The `arm1.*` compute names are
reserved-fleet naming and were purged from the codebase for that reason.)

Measured provisioning floor: **PROVISIONING 2–7 s** across the v1 matrix.

Code: `packages/millwright-state/src/buildspec.ts`,
`packages/millwright-cdk/src/build-project.ts`, `src/runtime/shim/`.

# Citations

[1] [Spec §11, §12](../../docs/specs/1-millwright-v1-implementable-specification.md)
