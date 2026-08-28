#!/usr/bin/env bash
# Per-boot startup for OpenInstinct: bring up the native PostgreSQL 16 server
# and ensure the development role/database exist. Idempotent and safe to rerun.
set -euo pipefail

export PATH="/usr/bin:$PATH"

# Start the cluster if it is not already accepting connections.
sudo pg_ctlcluster 16 main start 2>/dev/null || true

# Wait for readiness before touching roles/databases.
for _ in $(seq 1 30); do
  if sudo -u postgres pg_isready -q; then
    break
  fi
  sleep 1
done

# Ensure the development password and database exist (idempotent).
sudo -u postgres psql -v ON_ERROR_STOP=1 -c "ALTER USER postgres WITH PASSWORD 'postgres';"
if ! sudo -u postgres psql -tAc "SELECT 1 FROM pg_database WHERE datname='open_instinct'" | grep -q 1; then
  sudo -u postgres createdb open_instinct
fi
