# absurd deploy stack

Deployment/infrastructure layer for the swamp <-> absurd integration: a
Postgres container with the [absurd](https://github.com/earendil-works/absurd)
durable-execution schema applied and a `default` queue created.

## What's here

| File                 | Purpose                                                            |
| -------------------- | ------------------------------------------------------------------ |
| `docker-compose.yml` | Postgres 16 service (`absurd-postgres`) with a healthcheck + volume |
| `up.sh`              | Bring the stack up, apply schema, create the `default` queue       |
| `setup.sh`           | Idempotently apply schema + ensure `default` queue (called by `up.sh`) |
| `down.sh`            | Tear the stack down (`--volumes` also wipes data)                  |

## Connection string

```
postgresql://absurd:absurd@localhost:5432/absurd
```

| Setting  | Value      |
| -------- | ---------- |
| host     | localhost  |
| port     | 5432       |
| user     | absurd     |
| password | absurd     |
| database | absurd     |
| queue    | default    |

## Bring it up

```bash
./up.sh
```

This runs `docker compose up -d --wait` (blocks until the Postgres healthcheck
passes), then applies the absurd schema and ensures the `default` queue exists.
It is fully idempotent — re-running skips the schema apply if `absurd` already
exists and the queue creation is a no-op.

## Tear it down

```bash
./down.sh            # stop + remove container, KEEP data volume
./down.sh --volumes  # also remove the absurd-pgdata volume (wipes all data)
```

## Verify

```bash
# list absurd tables (expect queue-prefixed t_/r_/c_/e_/w_default + queues)
docker exec absurd-postgres psql -U absurd -d absurd -c "\dt absurd.*"

# confirm the default queue
docker exec absurd-postgres psql -U absurd -d absurd -c "select * from absurd.list_queues();"

# schema version
docker exec absurd-postgres psql -U absurd -d absurd -c "select absurd.get_schema_version();"
```

## How the schema is applied

`setup.sh` applies `/home/keeb/git/absurd/sql/absurd.sql` (the canonical
schema from the absurd reference repo) into the container via
`docker exec ... psql`, then creates the queue by calling the schema's own
`absurd.create_queue('default')` SQL function. We call the SQL function
directly rather than `absurdctl` so the setup has no Python/network
dependency and stays self-contained. The schema source path is overridable
via the `ABSURD_SQL` env var.

Notes:
- The schema apply is guarded by a check for the `absurd` schema, so an
  existing data volume is left untouched on re-run.
- `absurd.create_queue` uses `INSERT ... ON CONFLICT DO NOTHING` and
  `CREATE TABLE IF NOT EXISTS` internally, so re-running is safe (it only
  emits informational `NOTICE` lines).
