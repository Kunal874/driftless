#!/usr/bin/env bash
# Backfill under load: empty the index, start Driftless with backfill on, keep writing while it copies the
# existing rows, then reconcile. The naive backfill (T07.1) fails this (BUG-002); the watermark one must not.
#
# Usage: scripts/backfill-race.sh [DELAY_MS=0] [RATE_TX_PER_S=200] [SECONDS=60] [KILL_EVERY_S=0]
#   DELAY_MS widens the window between reading a chunk and writing it; RATE=0 means no concurrent writes;
#   KILL_EVERY_S > 0 SIGKILLs and restarts the connector that often until the backfill is done (it must resume).
# Exit code: reconcile's (0 = no drift, 1 = drift, 2 = couldn't check).
set -euo pipefail
export MSYS_NO_PATHCONV=1 # Git Bash: don't rewrite container paths
cd "$(dirname "$0")/.."

delay=${1:-0}
rate=${2:-200}
seconds=${3:-60}
kill_every=${4:-0}
meili=${MEILI_HOST:-http://127.0.0.1:7700}
auth="Authorization: Bearer ${MEILI_MASTER_KEY:-driftless-dev-master-key}"
workload_log=$(mktemp)
start_connector() { DRIFTLESS_BACKFILL=1 DRIFTLESS_BACKFILL_DEBUG_DELAY_MS=$delay docker compose up -d connector >/dev/null 2>&1; }
done_yet() { docker compose logs connector --since "$since" 2>/dev/null | grep -q 'backfill: done'; }

docker compose stop connector >/dev/null 2>&1 || true
curl -s -X DELETE -H "$auth" "$meili/indexes/products" >/dev/null
until [ "$(curl -s -o /dev/null -w '%{http_code}' -H "$auth" "$meili/indexes/products")" = 404 ]; do sleep 0.5; done
# Forget any earlier backfill's progress: resuming one into a freshly emptied index would skip rows.
docker compose exec -T postgres psql -U driftless -d shop -qc "DELETE FROM driftless_state WHERE name = 'backfill'" >/dev/null 2>&1 || true
echo "backfill-race: index emptied; backfill with a ${delay} ms read->write delay, writes at ${rate} tx/s for ${seconds} s" \
  "$([ "$kill_every" -gt 0 ] && echo ", SIGKILL every ${kill_every} s")"

since=$(date -u +%Y-%m-%dT%H:%M:%SZ)
start_connector
workload=""
if [ "$rate" -gt 0 ]; then
  scripts/workload.sh "$rate" "$seconds" > "$workload_log" 2>&1 &
  workload=$!
fi

kills=0
until done_yet; do
  if [ "$kill_every" -gt 0 ]; then
    sleep "$kill_every"
    done_yet && break
    docker compose kill -s SIGKILL connector >/dev/null 2>&1
    kills=$((kills + 1))
    start_connector # a docker kill isn't restarted by the restart policy (T05.3)
  else
    sleep 1
  fi
done
docker compose logs connector --since "$since" --no-log-prefix | grep -E 'backfill: (starting|resuming|done)' | sed 's/^/  /'
[ "$kills" -gt 0 ] && echo "  ${kills} SIGKILLs during the backfill"
if [ -n "$workload" ]; then
  wait "$workload"
  grep -E '^number of (transactions actually processed|failed transactions)' "$workload_log" | sed 's/^/  workload: /'
fi

status=0
node scripts/reconcile.ts --timeout=600 || status=$?
docker compose stop connector >/dev/null 2>&1 # don't leave it running with backfill switched on
exit "$status"
