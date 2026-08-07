---
id: "008"
title: Secrets management and injection
type: wayfinder:grilling
status: closed
assignee: dan
blocked-by: ["001"]
---

## Question

Where do workflow secrets live (Secrets Manager vs SSM Parameter Store), how are they
declared/referenced in workflow definitions, and how are they injected into running jobs
without leaking into logs or state? Blocked on
[Job compute runtime](001-job-compute-runtime.md): injection mechanics (env vars,
mounted files, IAM-scoped fetch at runtime) differ per compute service.

## Resolution

Decided live with Dan (2026-08-06):

- **Store**: SSM Parameter Store SecureString under `/millwright/secrets/<scope>/<NAME>`,
  encrypted with a **dedicated customer-managed KMS key** so reads require both
  `ssm:GetParameter` (decrypting) and `kms:Decrypt` — the same two-gate posture as
  Secrets Manager. The CMK (~$1/mo) is the design's one standing cost. Existing
  **Secrets Manager ARNs are accepted as passthrough references** so teams don't copy
  values out. Millwright system credentials (App PEM, deploy keys) stay in Secrets
  Manager per [Repo access auth](003-repo-access-auth.md).
- **Access model**: **explicit per-job declaration** in the workflow definition
  (`secrets: { NPM_TOKEN: Secret.named('npm-token') }`). Synth generates a per-job
  least-privilege IAM role granting only the declared parameters + `kms:Decrypt`,
  attached via `StartBuild`'s service-role override. Undeclared secrets are unreadable;
  a compromised build script can only exfiltrate what its job declared.
- **Injection**: CodeBuild-native buildspec `env.parameter-store` /
  `env.secrets-manager` — values arrive as env vars at job start with exact-match log
  masking for free. File-shaped secrets (SSH keys) are v1'd by a job step writing the
  env var to disk; a `SecretFile` construct is left in fog.
- **Authoring**: secrets are written via the millwright CLI (`millwright secrets set`),
  which owns the path convention and CMK binding.

**Constraints radiated**: local runner satisfies the same env-var contract from a local
`.env`/keychain — no SSM faking needed
([Local execution parity](007-local-execution-parity.md)). The definition-schema lint
must warn that masking is exact-match only — transformed secrets leak
([Workflow-definition construct API](004-workflow-definition-api.md)).
