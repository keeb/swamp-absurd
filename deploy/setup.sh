#!/usr/bin/env bash
# Idempotently apply the absurd schema and create the "default" queue against
# the running absurd-postgres container. Safe to re-run: schema apply is
# guarded by a check for the absurd schema, and create_queue uses
# ON CONFLICT DO NOTHING internally.
set -euo pipefail

CONTAINER="${ABSURD_PG_CONTAINER:-absurd-postgres}"
DB_USER="${POSTGRES_USER:-absurd}"
DB_NAME="${POSTGRES_DB:-absurd}"
QUEUE_NAME="${ABSURD_QUEUE:-default}"

# Path to the canonical absurd schema (read-only reference repo).
ABSURD_SQL="${ABSURD_SQL:-/home/keeb/git/absurd/sql/absurd.sql}"

if [[ ! -f "$ABSURD_SQL" ]]; then
  echo "ERROR: absurd schema not found at $ABSURD_SQL" >&2
  echo "Set ABSURD_SQL=/path/to/absurd.sql and re-run." >&2
  exit 1
fi

psql_exec() {
  docker exec -i "$CONTAINER" psql -v ON_ERROR_STOP=1 -U "$DB_USER" -d "$DB_NAME" "$@"
}

echo "==> Waiting for Postgres in container '$CONTAINER' to be ready..."
until docker exec "$CONTAINER" pg_isready -U "$DB_USER" -d "$DB_NAME" >/dev/null 2>&1; do
  sleep 1
done
echo "    Postgres is ready."

# --- Apply schema (idempotent) -------------------------------------------
SCHEMA_PRESENT="$(psql_exec -tA -c \
  "select 1 from information_schema.schemata where schema_name = 'absurd' limit 1;" \
  2>/dev/null || true)"

if [[ "$SCHEMA_PRESENT" == "1" ]]; then
  echo "==> absurd schema already present; skipping schema apply."
else
  echo "==> Applying absurd schema from $ABSURD_SQL ..."
  psql_exec -f - < "$ABSURD_SQL" >/dev/null
  echo "    Schema applied."
fi

# --- Create the default queue (idempotent) -------------------------------
echo "==> Ensuring queue '$QUEUE_NAME' exists ..."
psql_exec -c "select absurd.create_queue('$QUEUE_NAME');" >/dev/null
echo "    Queue '$QUEUE_NAME' ensured."

# --- Report --------------------------------------------------------------
echo "==> Schema version:"
psql_exec -tA -c "select absurd.get_schema_version();" | sed 's/^/    /'
echo "==> Queues:"
psql_exec -c "select queue_name from absurd.list_queues();" | sed 's/^/    /'

echo "==> setup complete."
