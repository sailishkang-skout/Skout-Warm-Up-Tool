#!/bin/sh
set -eu

# Build DATABASE_URL from discrete ECS/Secrets Manager fields when the full
# URL is not already provided (email-intel style host/password wiring).
# Do NOT append sslmode= — Node pg verifies Amazon RDS certs via the Pool
# `ssl: { rejectUnauthorized: false }` option instead (see src/shared/db/pool.ts).
#
# IMPORTANT: never assign to PORT here — that would clobber the HTTP listen
# port (3010) injected by ECS and make the API bind to DATABASE_PORT (5432).
if [ -z "${DATABASE_URL:-}" ] && [ -n "${DATABASE_HOST:-}" ]; then
  DB_USER="${DATABASE_USER:-skout}"
  DB_PORT="${DATABASE_PORT:-5432}"
  DB_NAME="${DATABASE_NAME:-email_warmup}"
  PASSWORD="${DATABASE_PASSWORD:?DATABASE_PASSWORD is required when DATABASE_URL is unset}"
  # URL-encode password characters that break connection strings.
  ENC_PASSWORD=$(node -e "process.stdout.write(encodeURIComponent(process.argv[1]))" "$PASSWORD")
  export DATABASE_URL="postgresql://${DB_USER}:${ENC_PASSWORD}@${DATABASE_HOST}:${DB_PORT}/${DB_NAME}"
fi

exec "$@"
