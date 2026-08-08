#!/usr/bin/env bash
# CodeBuild on-demand provisioning-latency spike (wayfinder ticket 012).
#
# Measures the PROVISIONING phase duration across the environment matrix
# millwright v1 will use: ARM small/medium x standard/custom image x
# privileged on/off, REPS builds each, via StartBuild overrides on one
# throwaway project (the same call shape millwright's dispatcher uses).
#
# Designed for AWS CloudShell (aws + jq preinstalled, admin credentials).
#   bash measure.sh run       # ~20-30 min, prints summary, auto-cleans up
#   bash measure.sh cleanup   # remove the throwaway project/role if a run died
#
# Tunables (env vars):
#   REPS=3                    builds per config
#   CUSTOM_IMAGE=...          defaults to a public-ECR debian image; point it at
#                             a private ECR arm64 image URI to measure that path
#   STANDARD_IMAGE=...        defaults to newest curated aarch64-standard image
#   PREFIX=mw-provlat-spike   name for the throwaway project/role
set -uo pipefail

PREFIX="${PREFIX:-mw-provlat-spike}"
REPS="${REPS:-3}"
CUSTOM_IMAGE="${CUSTOM_IMAGE:-public.ecr.aws/docker/library/debian:bookworm-slim}"
POLL_SECS=15

die() { echo "error: $*" >&2; exit 1; }

command -v aws >/dev/null || die "aws CLI not found"
command -v jq >/dev/null || die "jq not found"
aws sts get-caller-identity >/dev/null || die "no working AWS credentials"

cleanup() {
  aws codebuild delete-project --name "$PREFIX" >/dev/null 2>&1 && echo "deleted project $PREFIX"
  aws iam delete-role-policy --role-name "$PREFIX-role" --policy-name logs >/dev/null 2>&1
  aws iam delete-role --role-name "$PREFIX-role" >/dev/null 2>&1 && echo "deleted role $PREFIX-role"
  aws logs delete-log-group --log-group-name "/aws/codebuild/$PREFIX" >/dev/null 2>&1
}

wait_builds() {
  [ $# -eq 0 ] && return
  while :; do
    local n
    n=$(aws codebuild batch-get-builds --ids "$@" \
      | jq '[.builds[] | select(.buildComplete | not)] | length') || die "batch-get-builds failed"
    [ "$n" -eq 0 ] && break
    echo "    $n build(s) in flight..."
    sleep "$POLL_SECS"
  done
}

run() {
  local ROLE_ARN
  ROLE_ARN=$(aws iam get-role --role-name "$PREFIX-role" --query Role.Arn --output text 2>/dev/null)
  if [ -z "$ROLE_ARN" ] || [ "$ROLE_ARN" = "None" ]; then
    ROLE_ARN=$(aws iam create-role --role-name "$PREFIX-role" \
      --assume-role-policy-document '{"Version":"2012-10-17","Statement":[{"Effect":"Allow","Principal":{"Service":"codebuild.amazonaws.com"},"Action":"sts:AssumeRole"}]}' \
      --query Role.Arn --output text) || die "create-role failed"
    aws iam put-role-policy --role-name "$PREFIX-role" --policy-name logs \
      --policy-document '{"Version":"2012-10-17","Statement":[{"Effect":"Allow","Action":["logs:CreateLogGroup","logs:CreateLogStream","logs:PutLogEvents"],"Resource":"*"}]}' \
      || die "put-role-policy failed"
  fi

  if [ -z "${STANDARD_IMAGE:-}" ]; then
    STANDARD_IMAGE=$(aws codebuild list-curated-environment-images \
      | jq -r '[.platforms[].languages[].images[].name | select(test("aarch64-standard"))] | sort | last')
    [ -n "$STANDARD_IMAGE" ] && [ "$STANDARD_IMAGE" != "null" ] || die "no curated aarch64-standard image found; set STANDARD_IMAGE"
  fi
  echo "standard image: $STANDARD_IMAGE"
  echo "custom image:   $CUSTOM_IMAGE"
  echo "reps/config:    $REPS"

  cat > /tmp/$PREFIX-project.json <<EOF
{
  "name": "$PREFIX",
  "source": {"type": "NO_SOURCE", "buildspec": "version: 0.2\nphases:\n  build:\n    commands:\n      - echo provisioning-spike"},
  "artifacts": {"type": "NO_ARTIFACTS"},
  "environment": {"type": "ARM_CONTAINER", "image": "$STANDARD_IMAGE", "computeType": "BUILD_GENERAL1_SMALL", "privilegedMode": false},
  "serviceRole": "$ROLE_ARN"
}
EOF
  local created=""
  for _ in $(seq 1 12); do  # retry while the fresh role propagates
    if aws codebuild create-project --cli-input-json "file:///tmp/$PREFIX-project.json" >/dev/null 2>/tmp/$PREFIX-cperr; then
      created=1; break
    fi
    grep -q AlreadyExists /tmp/$PREFIX-cperr && { created=1; break; }
    sleep 5
  done
  [ -n "$created" ] || die "create-project failed: $(cat /tmp/$PREFIX-cperr)"

  # label computeType imageKind privileged
  local CONFIGS=(
    "small-standard-nopriv  BUILD_GENERAL1_SMALL  standard false"
    "small-standard-priv    BUILD_GENERAL1_SMALL  standard true"
    "medium-standard-nopriv BUILD_GENERAL1_MEDIUM standard false"
    "medium-standard-priv   BUILD_GENERAL1_MEDIUM standard true"
    "small-custom-nopriv    BUILD_GENERAL1_SMALL  custom   false"
    "small-custom-priv      BUILD_GENERAL1_SMALL  custom   true"
    "medium-custom-nopriv   BUILD_GENERAL1_MEDIUM custom   false"
    "medium-custom-priv     BUILD_GENERAL1_MEDIUM custom   true"
  )

  declare -A BUILD_CFG
  local ALL_IDS=()
  for cfg in "${CONFIGS[@]}"; do
    local label ctype imgkind priv img id
    read -r label ctype imgkind priv <<<"$cfg"
    img=$STANDARD_IMAGE; [ "$imgkind" = custom ] && img=$CUSTOM_IMAGE
    # --privileged-mode-override is a boolean flag pair in CLI v2, not a valued option
    local priv_flag="--no-privileged-mode-override"
    [ "$priv" = true ] && priv_flag="--privileged-mode-override"
    echo "config $label:"
    local ids=()
    for _ in $(seq 1 "$REPS"); do
      id=$(aws codebuild start-build --project-name "$PREFIX" \
        --compute-type-override "$ctype" \
        --image-override "$img" \
        "$priv_flag" \
        --image-pull-credentials-type-override CODEBUILD \
        --query 'build.id' --output text 2>/tmp/$PREFIX-sberr) \
        || { echo "    start-build FAILED: $(tr -d '\n' </tmp/$PREFIX-sberr)"; continue; }
      BUILD_CFG[$id]=$label
      ids+=("$id"); ALL_IDS+=("$id")
    done
    wait_builds "${ids[@]}"
  done

  [ ${#ALL_IDS[@]} -gt 0 ] || { cleanup; die "no builds started"; }

  local STAMP RAW OUT MAP
  STAMP=$(date +%Y%m%d-%H%M%S)
  RAW="$PWD/$PREFIX-raw-$STAMP.json"
  OUT="$PWD/$PREFIX-results-$STAMP.json"
  aws codebuild batch-get-builds --ids "${ALL_IDS[@]}" > "$RAW" || die "final batch-get-builds failed"
  MAP=$(for id in "${!BUILD_CFG[@]}"; do printf '%s\t%s\n' "$id" "${BUILD_CFG[$id]}"; done \
    | jq -Rs '[split("\n")[] | select(length>0) | split("\t") | {(.[0]): .[1]}] | add')

  jq --argjson m "$MAP" '[.builds[] | {
      config: $m[.id], id: .id, status: .buildStatus,
      queued_s:       ([.phases[] | select(.phaseType=="QUEUED")       | .durationInSeconds] | add // 0),
      provisioning_s: ([.phases[] | select(.phaseType=="PROVISIONING") | .durationInSeconds] | add // 0),
      total_s:        ([.phases[].durationInSeconds // 0] | add)
    }] | sort_by(.config)' "$RAW" > "$OUT"

  echo
  echo "== per-build (seconds) =="
  jq -r '(["config","status","queued","provisioning","total"], (.[] | [.config,.status,.queued_s,.provisioning_s,.total_s])) | @tsv' "$OUT" | column -t
  echo
  echo "== provisioning summary per config (seconds) =="
  jq -r '(["config","n","min","avg","max"],
    (group_by(.config)[] | [ .[0].config, length,
      ([.[].provisioning_s]|min), (([.[].provisioning_s]|add)/length*10|round/10), ([.[].provisioning_s]|max) ]))
    | @tsv' "$OUT" | column -t
  echo
  echo "results: $OUT (raw: $RAW)"
  cleanup
}

case "${1:-}" in
  run) run ;;
  cleanup) cleanup ;;
  *) echo "usage: $0 run|cleanup"; exit 1 ;;
esac
