#!/usr/bin/env bash
# Idempotent Cloud Agent setup for OpenInstinct (local-vault-assistant).
#
# Prepares durable, source-derived state after the repository is checked out:
# Node 24, pnpm, a native PostgreSQL 16 server, JS dependencies, and a
# local-only `.env`. Per-boot service startup lives in `.cursor/start.sh`.
set -euo pipefail

export PATH="/usr/bin:$PATH"
REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_ROOT"

# --- Node.js 24 (package.json engines + .node-version pin 24.x) ------------
if ! /usr/bin/node -v 2>/dev/null | grep -q '^v24'; then
  curl -fsSL https://deb.nodesource.com/setup_24.x | sudo -E bash -
  sudo apt-get install -y nodejs
fi

# --- pnpm 11.24.0 via corepack (packageManager pin) -----------------------
sudo corepack enable
sudo corepack prepare pnpm@11.24.0 --activate

# --- PostgreSQL 16 --------------------------------------------------------
# `pnpm dev` starts Postgres via Docker Compose, which is unavailable in the
# Cloud Agent VM. Instead we run a native server and use `pnpm dev:app`, the
# externally-managed-database path documented in the README.
if ! command -v pg_ctlcluster >/dev/null 2>&1; then
  sudo apt-get update
  sudo apt-get install -y postgresql postgresql-contrib
fi

# --- JavaScript dependencies ----------------------------------------------
pnpm install --frozen-lockfile

# --- Local development environment (git-ignored) --------------------------
# lib/env.ts supplies local defaults for Better Auth / encryption / AI Gateway
# in development, but DATABASE_URL and KERNEL_API_KEY have no defaults. The
# placeholder Kernel key lets the app boot; real browser execution needs a
# genuine key supplied as a secret.
if [ ! -f .env ]; then
  cat > .env <<'ENV'
DATABASE_URL=postgresql://postgres:postgres@127.0.0.1:5432/open_instinct
DATABASE_URL_UNPOOLED=postgresql://postgres:postgres@127.0.0.1:5432/open_instinct
KERNEL_API_KEY=local-dev-placeholder
ENV
fi
