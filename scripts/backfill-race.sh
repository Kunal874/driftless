#!/usr/bin/env bash
# Backfill under load: empty the index, start Driftless with backfill on, keep writing while it copies the
# existing rows, then reconcile. The naive backfill (T07.1) fails this (BUG-002); the watermark one must not.
#
# Usage: scripts/backfill-race.sh [DELAY_MS=0] [RATE_TX_PER_S=200] [SECONDS=60]
#   DELAY_MS widens the window between reading a chunk and writing it; RATE=0 means no concurrent writes.
# Exit code: reconcile's (0 = no drift, 1 = drift, 2 = couldn't check).
set -euo pipefail
export MSYS_NO_PATHCONV=1 # Git Bash: don't rewrite container paths
cd "$(dirname "$0")/.."

delay=${1:-0}
rate=${2:-200}
seconds=${3:-60}
meili=${MEILI_HOST:-http://127.0.0.1:7700}
auth="Authorization: Bearer ${MEILI_MASTER_KEY:-driftless-dev-master-key}"
workload_log=$(mktemp)

docker compose stop connector >/dev/null 2>&1 || true
curl -s -X DELETE -H "$auth" "$meili/indexes/products" >/dev/null
until [ "$(curl -s -o /dev/null -w '%{http_code}' -H "$auth" "$meili/indexes/products")" = 404 ]; do sleep 0.5; done
echo "backfill-race: index emptied; backfill with a ${delay} ms read->write delay, writes at ${rate} tx/s for ${seconds} s"

since=$(date -u +%Y-%m-%dT%H:%M:%SZ)
DRIFTLESS_BACKFILL=1 DRIFTLESS_BACKFILL_DEBUG_DELAY_MS=$delay docker compose up -d connector >/dev/null 2>&1
workload=""
if [ "$rate" -gt 0 ]; then
  scripts/workload.sh "$rate" "$seconds" > "$workload_log" 2>&1 &
  workload=$!
fi

until docker compose logs connector --since "$since" 2>/dev/null | grep -q 'backfill: done'; do sleep 1; done
docker compose logs connector --since "$since" --no-log-prefix | grep -m1 'backfill: done'
if [ -n "$workload" ]; then
  wait "$workload"
  grep -E '^number of (transactions actually processed|failed transactions)' "$workload_log" | sed 's/^/  workload: /'
fi

status=0
node scripts/reconcile.ts --timeout=600 || status=$?
docker compose stop connector >/dev/null 2>&1 # don't leave it running with backfill switched on
exit "$status"
