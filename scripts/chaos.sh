#!/usr/bin/env bash
# Chaos run: steady write load while the connector is SIGKILLed at random moments, then a full reconcile.
# Passing means 0 drift: every kill (mid-transaction, mid-write, between apply and ack) was harmless.
#
# Usage: scripts/chaos.sh [DURATION_S=600] [KILL_EVERY_S=30] [RATE_TX_PER_S=5]
#   Kills land at random gaps between 0.5x and 1.5x KILL_EVERY, so they hit different phases of the work.
# Exit code: reconcile's (0 = no drift, 1 = drift, 2 = couldn't check).
set -euo pipefail
export MSYS_NO_PATHCONV=1 # Git Bash: don't rewrite container paths
cd "$(dirname "$0")/.."
docker compose build -q connector # the image must hold the code on disk (T10.2), not an older build

duration=${1:-600}
every=${2:-30}
rate=${3:-5}
workload_log=$(mktemp)

echo "chaos: ${duration} s of writes at ${rate} tx/s, SIGKILL about every ${every} s"
docker compose up -d connector >/dev/null 2>&1

scripts/workload.sh "$rate" "$duration" > "$workload_log" 2>&1 &
workload=$!

kills=0
deadline=$((SECONDS + duration))
while :; do
  gap=$((every / 2 + RANDOM % (every + 1)))
  [ $((SECONDS + gap)) -lt "$deadline" ] || break
  sleep "$gap"
  docker compose kill -s SIGKILL connector >/dev/null 2>&1
  kills=$((kills + 1))
  echo "  $(date +%T) kill #${kills}"
  docker compose up -d connector >/dev/null 2>&1 # a docker kill counts as a manual stop: restart it ourselves
done

if ! wait "$workload"; then
  echo "chaos: the workload failed:" >&2
  cat "$workload_log" >&2
  exit 2
fi
grep -E '^number of (transactions actually processed|failed transactions)' "$workload_log" | sed 's/^/  workload: /'

echo "chaos: ${kills} kills done; waiting for Driftless to catch up, then reconciling"
node scripts/reconcile.ts --timeout=1800
