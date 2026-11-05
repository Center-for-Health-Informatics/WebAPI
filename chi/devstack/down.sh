#!/usr/bin/env bash
# Stop and remove the dev stack's containers. The Postgres volume is kept;
# `container volume rm webapi-pgdata` drops it.
set -uo pipefail
for c in atlas3 webapi webapi-postgres; do
  container stop "$c" >/dev/null 2>&1
  container rm "$c" >/dev/null 2>&1
done
echo "stopped (volume webapi-pgdata kept)"
