#!/usr/bin/env bash

set -euo pipefail

POSTGRES_HOST="${POSTGRES_HOST:-127.0.0.1}"
POSTGRES_PORT="${POSTGRES_PORT:-5432}"
POSTGRES_USER="${POSTGRES_USER:-postgres}"
POSTGRES_PASSWORD="${POSTGRES_PASSWORD:-postgres}"
POSTGRES_DB="${POSTGRES_DB:-clawtriage}"

REDIS_HOST="${REDIS_HOST:-127.0.0.1}"
REDIS_PORT="${REDIS_PORT:-6379}"

DATA_ROOT="${DATA_ROOT:-/data}"
PGDATA_DIR="${PGDATA_DIR:-${DATA_ROOT}/postgres}"
REDIS_DATA_DIR="${REDIS_DATA_DIR:-${DATA_ROOT}/redis}"

export DATABASE_URL="${DATABASE_URL:-postgres://${POSTGRES_USER}:${POSTGRES_PASSWORD}@${POSTGRES_HOST}:${POSTGRES_PORT}/${POSTGRES_DB}}"
export REDIS_URL="${REDIS_URL:-redis://${REDIS_HOST}:${REDIS_PORT}}"

mkdir -p "${PGDATA_DIR}" "${REDIS_DATA_DIR}"
chown -R postgres:postgres "${PGDATA_DIR}"
chown -R redis:redis "${REDIS_DATA_DIR}"
chmod 700 "${PGDATA_DIR}"

if [[ ! -f "${PGDATA_DIR}/PG_VERSION" ]]; then
  echo "Initializing Postgres data directory at ${PGDATA_DIR}"
  su-exec postgres initdb -D "${PGDATA_DIR}" >/dev/null
fi

su-exec postgres postgres -D "${PGDATA_DIR}" -h "${POSTGRES_HOST}" -p "${POSTGRES_PORT}" -k /tmp &
POSTGRES_PID=$!

for _ in $(seq 1 60); do
  if su-exec postgres pg_isready -h "${POSTGRES_HOST}" -p "${POSTGRES_PORT}" -d postgres >/dev/null 2>&1; then
    break
  fi
  sleep 1
done

if ! su-exec postgres pg_isready -h "${POSTGRES_HOST}" -p "${POSTGRES_PORT}" -d postgres >/dev/null 2>&1; then
  echo "Postgres failed to become ready"
  exit 1
fi

su-exec postgres psql \
  -v ON_ERROR_STOP=1 \
  -v app_user="${POSTGRES_USER}" \
  -v app_pass="${POSTGRES_PASSWORD}" \
  -v app_db="${POSTGRES_DB}" \
  -h "${POSTGRES_HOST}" \
  -p "${POSTGRES_PORT}" \
  postgres <<'SQL'
SELECT format('CREATE ROLE %I LOGIN PASSWORD %L', :'app_user', :'app_pass')
WHERE NOT EXISTS (
  SELECT 1 FROM pg_catalog.pg_roles WHERE rolname = :'app_user'
)\gexec

SELECT format('ALTER ROLE %I LOGIN PASSWORD %L', :'app_user', :'app_pass')
WHERE EXISTS (
  SELECT 1 FROM pg_catalog.pg_roles WHERE rolname = :'app_user'
)\gexec

SELECT format('CREATE DATABASE %I OWNER %I', :'app_db', :'app_user')
WHERE NOT EXISTS (
  SELECT 1 FROM pg_database WHERE datname = :'app_db'
)\gexec
SQL

su-exec redis redis-server \
  --bind "${REDIS_HOST}" \
  --port "${REDIS_PORT}" \
  --dir "${REDIS_DATA_DIR}" \
  --appendonly yes \
  --save 60 1000 &
REDIS_PID=$!

for _ in $(seq 1 60); do
  if redis-cli -h "${REDIS_HOST}" -p "${REDIS_PORT}" ping >/dev/null 2>&1; then
    break
  fi
  sleep 1
done

if ! redis-cli -h "${REDIS_HOST}" -p "${REDIS_PORT}" ping >/dev/null 2>&1; then
  echo "Redis failed to become ready"
  exit 1
fi

if [[ "${SKIP_DB_MIGRATE:-0}" != "1" ]]; then
  pnpm db:migrate
fi

shutdown() {
  if [[ -n "${API_PID:-}" ]]; then
    kill "${API_PID}" 2>/dev/null || true
  fi
  if [[ -n "${WORKER_PID:-}" ]]; then
    kill "${WORKER_PID}" 2>/dev/null || true
  fi
  if [[ -n "${REDIS_PID:-}" ]]; then
    kill "${REDIS_PID}" 2>/dev/null || true
  fi
  if [[ -n "${POSTGRES_PID:-}" ]]; then
    kill "${POSTGRES_PID}" 2>/dev/null || true
  fi

  wait "${API_PID:-}" 2>/dev/null || true
  wait "${WORKER_PID:-}" 2>/dev/null || true
  wait "${REDIS_PID:-}" 2>/dev/null || true
  wait "${POSTGRES_PID:-}" 2>/dev/null || true
}

trap shutdown INT TERM

pnpm --filter @clawtriage/api start &
API_PID=$!

pnpm --filter @clawtriage/worker start &
WORKER_PID=$!

set +e
wait -n "${POSTGRES_PID}" "${REDIS_PID}" "${API_PID}" "${WORKER_PID}"
EXIT_CODE=$?
set -e

shutdown
exit "${EXIT_CODE}"
