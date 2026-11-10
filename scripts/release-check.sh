#!/usr/bin/env bash
# Release check (T15.5): run a PUBLISHED release the way a user gets it, on a throwaway stack. Two rounds, each on
# fresh data: (1) the image from GHCR, (2) the CLI from npm, via `npx` in a clean node container. Each one must backfill
# the seeded tables by itself, survive SIGKILLs under write load, and leave 0 drift, checked by the published
# `driftless reconcile` run from the host.
#
# Usage: scripts/release-check.sh [VERSION=package.json's] [ROWS=20000]
# Uses its own compose project (driftless-release) on the usual ports, so stop the main stack first. It deletes that
# project's volumes (never the main stack's) at the start of each round and at the end.
# Exit code: 0 = both rounds passed; anything else = the first failure.
set -euo pipefail
export MSYS_NO_PATHCONV=1 # Git Bash: don't rewrite container paths
cd "$(dirname "$0")/.."
export COMPOSE_PROJECT_NAME=driftless-release

version=${1:-$(node -p 'require("./package.json").version')}
rows=${2:-20000}
net=${COMPOSE_PROJECT_NAME}_default
name=driftless-release-check
if [ -n "$(docker ps -q --filter name='^driftless-postgres-1$')" ]; then
  echo "release-check: the main stack is running on the same ports; stop it first: docker compose --profile connector --profile metrics stop" >&2
  exit 2
fi

# The config as a user would write it for containers: service names, not 127.0.0.1. Secrets go in as env.
cfg=$(mktemp -d)
cat > "$cfg/driftless.config.json" <<'JSON'
{
  "postgres": { "host": "postgres", "port": 5432, "user": "driftless", "database": "shop" },
  "meilisearch": { "host": "http://meilisearch:7700" },
  "sync": [
    { "table": "public.products", "index": "products", "primaryKey": "id", "redisKeyPrefix": "product:" },
    { "table": "public.customers", "index": "customers", "primaryKey": "id", "redisKeyPrefix": "customer:" }
  ],
  "redis": { "url": "redis://redis:6379" }
}
JSON
cfg_host=$(cd "$cfg" && (pwd -W 2>/dev/null || pwd)) # a path Docker understands (Windows: C:/...)
# The published reconcile runs from an empty folder: in this repo, whose package.json IS driftless-cdc, npx would take
# the checkout for the package and look for a `driftless` bin that was never installed here.
outside=$(mktemp -d)
host_cfg="$(pwd -W 2>/dev/null || pwd)/driftless.config.json" # the repo's config: the usual host ports
log() { echo "release-check: $(date +%T) $*"; }
finish() { docker rm -f "$name" >/dev/null 2>&1 || true; docker compose down -v >/dev/null 2>&1 || true; }
trap finish EXIT

round() { # $1 = what runs; the rest = `docker run` arguments after the common ones
  local what=$1; shift
  log "[$what] fresh stack, $rows products and $((rows / 4)) customers"
  docker compose down -v >/dev/null 2>&1
  docker compose up -d --wait >/dev/null 2>&1
  docker compose exec -T postgres psql -q -U driftless -d shop -v rows="$rows" -f /db/seed.sql >/dev/null
  docker compose exec -T postgres psql -q -U driftless -d shop -v rows="$((rows / 4))" -f /db/seed-customers.sql >/dev/null

  docker run -d --name "$name" --network "$net" -v "$cfg_host:/cfg:ro" -e DRIFTLESS_CONFIG=/cfg/driftless.config.json \
    -e PGPASSWORD=driftless -e MEILI_MASTER_KEY=driftless-dev-master-key "$@" >/dev/null
  for _ in $(seq 1 300); do
    docker logs "$name" 2>&1 | grep -q 'backfill: every table is backfilled' && break
    sleep 1
  done
  docker logs "$name" 2>&1 | grep -q 'backfill: every table is backfilled' || { log "[$what] FAILED: no backfill within 300 s"; docker logs --tail 30 "$name"; exit 1; }
  log "[$what] $(docker logs "$name" 2>&1 | grep -m1 'streaming slot' | sed 's/^driftless: //')"
  log "[$what] backfilled both tables; now 60 s of writes with a SIGKILL every ~15 s"

  local workload_log
  workload_log=$(mktemp)
  WORKLOAD_MIX=multi scripts/workload.sh 200 60 > "$workload_log" 2>&1 &
  local workload=$!
  for kill in 1 2 3; do
    sleep 15
    docker kill -s SIGKILL "$name" >/dev/null
    docker start "$name" >/dev/null
    log "[$what] SIGKILL #$kill, started again"
  done
  wait "$workload"
  grep -E '^number of (transactions actually processed|failed transactions)' "$workload_log" | sed "s/^/  [$what] workload: /"

  # The published reconcile, from the host, against the same stack (its ports are the usual ones).
  local status=0
  (cd "$outside" && npx -y "driftless-cdc@$version" reconcile --config "$host_cfg" --timeout 300) > "$workload_log" 2>&1 \
    || status=$?
  grep -vE '^\s+(missing|extra|mismatched) (documents|keys): +0$' "$workload_log" | sed "s/^/  [$what] /"
  [ "$status" -eq 0 ] || { log "[$what] FAILED: reconcile exited with $status (1 = drift, 2 = couldn't check)"; exit 1; }
  docker rm -f "$name" >/dev/null
}

log "checking driftless $version as published"
docker pull -q "ghcr.io/kunal874/driftless:$version" >/dev/null # anonymous: proves the image is public
log "image pulled anonymously: $(docker image inspect "ghcr.io/kunal874/driftless:$version" --format '{{.Architecture}}, {{index .Config.Labels "org.opencontainers.image.revision"}}')"
round image "ghcr.io/kunal874/driftless:$version"
round npm node:24.18.0-alpine npx -y "driftless-cdc@$version"
log "PASSED: the image and the npm CLI $version each backfilled, survived 3 SIGKILLs under load, and left 0 drift"
