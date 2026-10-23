#!/usr/bin/env bash
# End-to-end check on a fresh stack: seed → Driftless backfills by itself → chaos (random SIGKILLs under load) →
# reconcile = 0 → reconcile self-test. CI runs it on every push (.github/workflows/ci.yml); it also runs locally.
#
# Usage: scripts/ci-e2e.sh [ROWS=20000] [CHAOS_SECONDS=120]
# It RE-SEEDS `products` (the seed empties the table first), so outside CI it refuses the default compose project.
# Locally: stop the main stack (same ports), then  COMPOSE_PROJECT_NAME=driftless-ci scripts/ci-e2e.sh
# Exit code: 0 = no drift; anything else = a failed step.
set -euo pipefail
export MSYS_NO_PATHCONV=1 # Git Bash: don't rewrite container paths
cd "$(dirname "$0")/.."

rows=${1:-20000}
chaos_seconds=${2:-120}

if [ "${CI:-}" != true ] && [ "${COMPOSE_PROJECT_NAME:-driftless}" = driftless ]; then
  echo "ci-e2e: this re-seeds products; run it in its own project: COMPOSE_PROJECT_NAME=driftless-ci $0" >&2
  exit 2
fi

echo "ci-e2e: stack up, ${rows} rows"
docker compose up -d --wait
docker compose exec -T postgres psql -q -U driftless -d shop -v rows="$rows" -f /db/seed.sql >/dev/null

echo "ci-e2e: starting Driftless; the index is empty, so it backfills"
docker compose up -d --build --wait connector
for _ in $(seq 1 180); do
  docker compose logs connector 2>&1 | grep -q 'backfill: done' && break
  sleep 1
done
docker compose logs connector 2>&1 | grep 'backfill: done' || { echo "ci-e2e: no backfill within 180 s" >&2; exit 1; }

scripts/chaos.sh "$chaos_seconds" 10 200
node scripts/reconcile.ts --self-test
