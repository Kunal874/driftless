#!/usr/bin/env bash
# Slow sink: freeze Meilisearch (docker pause) under write load and watch Driftless's memory and the WAL Postgres
# holds for it; then unfreeze and reconcile. With backpressure (D-025), memory stays flat and the backlog waits in
# Postgres's WAL instead.
#
# Usage: scripts/slow-sink.sh [PAUSE_S=300] [RATE_TX_PER_S=200] [MAX_PENDING=50000]
# Exit code: reconcile's (0 = no drift, 1 = drift, 2 = couldn't check).
set -euo pipefail
export MSYS_NO_PATHCONV=1 # Git Bash: don't rewrite container paths
cd "$(dirname "$0")/.."

pause_s=${1:-300}
rate=${2:-200}
max=${3:-50000}
workload_log=$(mktemp)
sql() { docker compose exec -T postgres psql -U driftless -d shop -tAc "$1"; }
held_wal() { sql "SELECT pg_size_pretty(pg_wal_lsn_diff(pg_current_wal_lsn(), restart_lsn)) FROM pg_replication_slots WHERE slot_name = 'driftless_slot'"; }
memory() { docker stats --no-stream --format '{{.MemUsage}}' driftless-connector-1 | cut -d/ -f1 | tr -d ' '; }

since=$(date -u +%Y-%m-%dT%H:%M:%SZ)
DRIFTLESS_MAX_PENDING=$max docker compose up -d --force-recreate connector >/dev/null 2>&1
sleep 5
scripts/workload.sh "$rate" $((pause_s + 60)) > "$workload_log" 2>&1 &
workload=$!
sleep 15
echo "slow-sink: before the freeze: connector memory $(memory), WAL held for the slot $(held_wal)"
docker compose pause meilisearch >/dev/null 2>&1
echo "slow-sink: Meilisearch frozen for ${pause_s} s under ${rate} tx/s (cap: ${max} waiting changes)"
for ((t = 15; t <= pause_s; t += 15)); do
  sleep 15
  echo "  +${t} s: connector memory $(memory), WAL held for the slot $(held_wal)"
done
docker compose unpause meilisearch >/dev/null 2>&1
echo "slow-sink: Meilisearch unfrozen"

wait "$workload"
grep -E '^number of (transactions actually processed|failed transactions)' "$workload_log" | sed 's/^/  workload: /' || true

status=0
node scripts/reconcile.ts --timeout=900 || status=$?
echo "slow-sink: after catching up: connector memory $(memory), WAL held for the slot $(held_wal)"

# Keep the connector's whole log: the next run recreates the container, which deletes it.
connector_log=$(mktemp)
docker compose logs connector --since "$since" --no-log-prefix > "$connector_log" 2>&1 || true
echo "  log: $(grep -c 'paused reading' "$connector_log" || true) pause(s), $(grep -c 'fatal' "$connector_log" || true) fatal error(s), $(grep -c 'streaming slot' "$connector_log" || true) start(s); full log: $connector_log"
grep -A8 'fatal' "$connector_log" | head -40 | sed 's/^/  log: /' || true
docker compose stop connector >/dev/null 2>&1
exit "$status"
