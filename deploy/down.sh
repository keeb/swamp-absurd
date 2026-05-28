#!/usr/bin/env bash
# Tear down the absurd Postgres stack.
#   ./down.sh             stop and remove the container (data volume kept)
#   ./down.sh --volumes   also remove the named data volume (wipes all data)
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"

WIPE_VOLUMES=0
for arg in "$@"; do
  case "$arg" in
    -v|--volumes)
      WIPE_VOLUMES=1
      ;;
    -h|--help)
      grep '^#' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'
      exit 0
      ;;
    *)
      echo "Unknown argument: $arg" >&2
      exit 1
      ;;
  esac
done

if [[ "$WIPE_VOLUMES" -eq 1 ]]; then
  echo "==> Tearing down stack AND removing data volume (--volumes)..."
  docker compose down --volumes
else
  echo "==> Tearing down stack (data volume preserved)..."
  docker compose down
fi

echo "==> Done."
