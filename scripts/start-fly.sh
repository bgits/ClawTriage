#!/usr/bin/env bash

set -euo pipefail

shutdown() {
  if [[ -n "${API_PID:-}" ]]; then
    kill "${API_PID}" 2>/dev/null || true
  fi
  if [[ -n "${WORKER_PID:-}" ]]; then
    kill "${WORKER_PID}" 2>/dev/null || true
  fi

  wait "${API_PID:-}" 2>/dev/null || true
  wait "${WORKER_PID:-}" 2>/dev/null || true
}

trap shutdown INT TERM

pnpm --filter @clawtriage/api start &
API_PID=$!

pnpm --filter @clawtriage/worker start &
WORKER_PID=$!

set +e
wait -n "${API_PID}" "${WORKER_PID}"
EXIT_CODE=$?
set -e

shutdown
exit "${EXIT_CODE}"
