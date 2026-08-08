# CodeBuild provisioning-latency spike

Asset for [CodeBuild provisioning-latency spike](../../wayfinder/tickets/012-codebuild-provisioning-latency-spike.md).
Measures the `PROVISIONING` phase of trivial CodeBuild on-demand builds across the
matrix millwright v1 will use — ARM small/medium × standard/custom image ×
privileged on/off, 3 builds each (24 total, a few cents) — using `StartBuild`
overrides on a single throwaway project, the same call shape millwright's
dispatcher will use.

## Runbook (human, ~30 min mostly waiting)

1. Open **AWS CloudShell** in the region millwright would deploy to (aws + jq
   are preinstalled and your credentials are already there).
2. Upload `measure.sh` (CloudShell: Actions → Upload file), or paste its
   contents into a file.
3. Run `bash measure.sh run`. It creates a throwaway project + role named
   `mw-provlat-spike*`, runs the matrix config-by-config, prints per-build and
   per-config summary tables, writes `mw-provlat-spike-results-<stamp>.json`,
   and deletes the throwaway resources.
4. Optional: rerun with `CUSTOM_IMAGE=<your-private-ecr-arm64-image-uri>` to
   measure the private-ECR pull path instead of the public-ECR default.
5. Bring the two printed tables (or the results JSON) back to a wayfinder
   session to resolve the ticket. Committing the results file into this
   directory works too.
6. Only if the run died partway: `bash measure.sh cleanup`.

Notes: a `start-build FAILED` line for the medium configs would mean ARM
medium on-demand isn't available in that region/account — the rest of the
matrix still runs and the failure itself is a finding. `QUEUED` time (account
concurrency limits) is reported separately and excluded from provisioning.
