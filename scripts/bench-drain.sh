#!/usr/bin/env bash
# Backlog-drain benchmark: write a backlog of transactions while Driftless is stopped, then start the
# connector service with the given settings and time how long it takes to catch up. Ends with a full
# reconcile, so a fast but wrong run can't pass.
#
# Usage: scripts/bench-drain.sh LANES BATCH_MAX [RATE_TX_PER_S=200] [SECONDS=10]
# The drain time includes the container's start-up (about a second). Exit code: reconcile's.
set -euo pipefail
export MSYS_NO_PATHCONV=1 # Git Bash: don't rewrite container paths
cd "$(dirname "$0")/.."
docker compose build -q connector # the image must hold the code on disk (T10.2), not an older build

lanes=${1:?lanes}
batch=${2:?batch max}
rate=${3:-200}
seconds=${4:-10}

docker compose stop connector >/dev/null 2>&1 || true
tx=$(scripts/workload.sh "$rate" "$seconds" 4 | sed -nE 's/^number of transactions actually processed: ([0-9]+).*/\1/p')
echo "bench: backlog of ${tx} transactions; starting Driftless with ${lanes} lane(s), up to ${batch} changes per write"

DRIFTLESS_LANES=$lanes DRIFTLESS_BATCH_MAX=$batch docker compose up -d connector >/dev/null 2>&1
status=0
result=$(node scripts/reconcile.ts --timeout=1800) || status=$?
docker compose stop connector >/dev/null 2>&1
echo "$result"

waited_ms=$(sed -nE 's/.*caught up after waiting ([0-9]+) ms.*/\1/p' <<<"$result")
if [ -n "$waited_ms" ]; then
  awk -v tx="$tx" -v ms="$waited_ms" -v l="$lanes" -v b="$batch" \
    'BEGIN { printf "bench: %d transactions drained in %.1f s = %.0f transactions/s (lanes %d, batch <= %d)\n", tx, ms / 1000, tx / (ms / 1000), l, b }'
fi
exit "$status"
