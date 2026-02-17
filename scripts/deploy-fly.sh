#!/usr/bin/env bash

set -euo pipefail

if ! command -v flyctl >/dev/null 2>&1; then
  echo "flyctl is required but not installed." >&2
  exit 1
fi

flyctl deploy --remote-only
flyctl scale count app=1
flyctl status
