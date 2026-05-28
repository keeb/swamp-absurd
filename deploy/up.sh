#!/usr/bin/env bash
# Bring the absurd Postgres stack up, then apply the schema and create the
# "default" queue. Fully idempotent — safe to run repeatedly.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"

echo "==> Starting Postgres stack (docker compose up -d)..."
docker compose up -d --wait

# `--wait` blocks until the healthcheck reports healthy, but setup.sh also
# polls pg_isready defensively.
"$SCRIPT_DIR/setup.sh"

echo ""
echo "Stack is up. Connect with:"
echo "  postgresql://absurd:absurd@localhost:5432/absurd"
