#!/usr/bin/env bash
# Redis crash test (T12.5, D-029): SIGKILL Redis under write load, start it again, then reconcile the cache.
# Each run starts a fresh stack in its own compose project, so the modes don't share data.
#
# Usage: COMPOSE_PROJECT_NAME=driftless-redis scripts/redis-crash.sh MODE [RATE=200] [SECONDS=150] [KILL_AT=100]
#   MODE always   AOF, fsync before every reply (what Driftless ships)
#        everysec AOF, fsync once a second (Redis's AOF default)
#        rdb      no AOF, a snapshot every 60 s (Redis's out-of-the-box setup)
# A process kill keeps whatever Redis already write()-ed in the OS page cache, so it can't show everysec's
# one-second window; that needs an OS crash or power loss, which this test can't cause.
# Exit code: reconcile's (0 = no drift, 1 = drift, 2 = couldn't check).
set -euo pipefail
export MSYS_NO_PATHCONV=1 # Git Bash: don't rewrite container paths
cd "$(dirname "$0")/.."

mode=${1:?usage: COMPOSE_PROJECT_NAME=driftless-redis scripts/redis-crash.sh always|everysec|rdb [RATE] [SECONDS] [KILL_AT]}
rate=${2:-200}
seconds=${3:-150}
kill_at=${4:-100}
if [ "${COMPOSE_PROJECT_NAME:-driftless}" = driftless ]; then
  echo "redis-crash: this rebuilds the stack from scratch; run it in its own project: COMPOSE_PROJECT_NAME=driftless-redis $0 $mode" >&2
  exit 2
fi
case $mode in
  always | everysec) export REDIS_APPENDONLY=yes REDIS_APPENDFSYNC=$mode REDIS_SAVE= ;;
  rdb) export REDIS_APPENDONLY=no REDIS_APPENDFSYNC=everysec REDIS_SAVE='60 1' ;;
  *) echo "redis-crash: unknown mode '$mode'" >&2; exit 2 ;;
esac

echo "redis-crash: $mode, fresh stack in project $COMPOSE_PROJECT_NAME"
docker compose --profile connector down -v >/dev/null 2>&1 || true # this project only (guarded above)
docker compose up -d --wait >/dev/null 2>&1
docker compose exec -T postgres psql -q -U driftless -d shop -v rows=20000 -f /db/seed.sql >/dev/null
docker compose up -d --build --wait connector >/dev/null 2>&1
for _ in $(seq 1 180); do docker compose logs connector 2>&1 | grep -q 'backfill: every table is backfilled' && break; sleep 1; done
echo "redis-crash: $(docker compose exec -T redis redis-cli CONFIG GET appendonly | tr '\n' ' ')$(docker compose exec -T redis redis-cli CONFIG GET appendfsync | tr '\n' ' ')$(docker compose exec -T redis redis-cli CONFIG GET save | tr '\n' ' ')"

workload_log=$(mktemp)
scripts/workload.sh "$rate" "$seconds" > "$workload_log" 2>&1 &
workload=$!
sleep "$kill_at"
docker compose kill -s SIGKILL redis >/dev/null 2>&1
echo "redis-crash: $(date +%T) Redis SIGKILLed after ${kill_at} s of ${rate} tx/s"
docker compose up -d --wait redis >/dev/null 2>&1
echo "redis-crash: $(date +%T) Redis back with $(docker compose exec -T redis redis-cli DBSIZE) keys"
wait "$workload"
grep -E '^number of (transactions actually processed|failed transactions)' "$workload_log" | sed 's/^/  workload: /' || true

status=0
node scripts/reconcile.ts --timeout=600 || status=$?
echo "redis-crash: connector log: $(docker compose logs connector 2>&1 | grep -c 'redis is unavailable' || true) retried write(s), $(docker compose logs connector 2>&1 | grep -c 'fatal' || true) fatal error(s)"
exit "$status"
