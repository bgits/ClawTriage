#!/usr/bin/env bash

set -euo pipefail

usage() {
  cat <<'EOF'
Usage:
  ./scripts/trigger-public-scan.sh --owner <owner> --repo <repo> [--max-open-prs <n>] [--snapshot <id>]

Required environment variables:
  FLY_APP_URL         Example: https://clawtriage.fly.dev
  OPS_TRIGGER_TOKEN   Bearer token for /api/ops/public-scan
EOF
}

validate_owner_or_repo() {
  local value="$1"
  [[ "$value" =~ ^[A-Za-z0-9_.-]+$ ]]
}

validate_snapshot() {
  local value="$1"
  [[ "$value" =~ ^[A-Za-z0-9._:-]+$ ]]
}

OWNER=""
REPO=""
MAX_OPEN_PRS=""
SNAPSHOT=""

while [[ $# -gt 0 ]]; do
  case "$1" in
    --owner)
      OWNER="${2:-}"
      shift 2
      ;;
    --repo)
      REPO="${2:-}"
      shift 2
      ;;
    --max-open-prs)
      MAX_OPEN_PRS="${2:-}"
      shift 2
      ;;
    --snapshot)
      SNAPSHOT="${2:-}"
      shift 2
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      echo "Unknown argument: $1" >&2
      usage
      exit 1
      ;;
  esac
done

if [[ -z "${FLY_APP_URL:-}" || -z "${OPS_TRIGGER_TOKEN:-}" ]]; then
  echo "FLY_APP_URL and OPS_TRIGGER_TOKEN must be set." >&2
  usage
  exit 1
fi

if [[ -z "${OWNER}" || -z "${REPO}" ]]; then
  echo "--owner and --repo are required." >&2
  usage
  exit 1
fi

if ! validate_owner_or_repo "${OWNER}" || ! validate_owner_or_repo "${REPO}"; then
  echo "--owner and --repo must match [A-Za-z0-9_.-]+" >&2
  exit 1
fi

if [[ -n "${MAX_OPEN_PRS}" ]]; then
  if ! [[ "${MAX_OPEN_PRS}" =~ ^[0-9]+$ ]] || [[ "${MAX_OPEN_PRS}" -le 0 ]]; then
    echo "--max-open-prs must be a positive integer." >&2
    exit 1
  fi
fi

if [[ -n "${SNAPSHOT}" ]] && ! validate_snapshot "${SNAPSHOT}"; then
  echo "--snapshot must match [A-Za-z0-9._:-]+" >&2
  exit 1
fi

PAYLOAD="{\"owner\":\"${OWNER}\",\"repo\":\"${REPO}\""
if [[ -n "${SNAPSHOT}" ]]; then
  PAYLOAD+=",\"snapshot\":\"${SNAPSHOT}\""
fi
if [[ -n "${MAX_OPEN_PRS}" ]]; then
  PAYLOAD+=",\"maxOpenPrs\":${MAX_OPEN_PRS}"
fi
PAYLOAD+="}"

curl --fail-with-body --silent --show-error \
  -X POST "${FLY_APP_URL%/}/api/ops/public-scan" \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer ${OPS_TRIGGER_TOKEN}" \
  -d "${PAYLOAD}"

echo
