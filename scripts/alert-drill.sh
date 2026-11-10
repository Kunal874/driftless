#!/usr/bin/env bash
# Alert drill (T14.5): make each Driftless alert fire for real on the local stack, then undo the cause, check that the
# alert resolves, and (where data flowed meanwhile) reconcile. Needs the metrics profile:
#   docker compose --profile metrics up -d
#
# Usage: scripts/alert-drill.sh down|stalled|slot [RATE_TX_PER_S]
#   down     SIGKILL the connector and leave it down → DriftlessDown fires; restart it → resolves
#   stalled  freeze Meilisearch under write load (default 200 tx/s) → DriftlessStalled fires; unfreeze → resolves
#   slot     recreate Postgres with the slot WAL cap at 256 MB, freeze Meilisearch under load (default 50 tx/s), and
#            grow the WAL in steps with pg_logical_emit_message (WAL only: Driftless doesn't subscribe to messages):
#            ~60 % of the cap → DriftlessSlotWalHigh, ~85 % → DriftlessSlotWalCritical. It never reaches 100 %, which
#            would lose the slot (D-026). Then unfreeze, wait for both to resolve, and put the 1 GB cap back.
# HOLD_S (default 30): how long the last alert is left firing before the cause is undone (time for a screenshot).
# Exit code: 0 = every alert fired and resolved as expected (and reconcile found 0 drift); otherwise not 0.
set -euo pipefail
export MSYS_NO_PATHCONV=1 # Git Bash: don't rewrite container paths
cd "$(dirname "$0")/.."

phase=${1:?usage: scripts/alert-drill.sh down|stalled|slot [RATE_TX_PER_S]}
hold=${HOLD_S:-30}
started=$(date +%s)
sql() { docker compose exec -T postgres psql -U driftless -d shop -tAc "$1"; }
log() { echo "  $(date +%T) +$(($(date +%s) - started)) s: $*"; }

# One alert's state in Prometheus: inactive, pending or firing.
state() {
  curl -s 127.0.0.1:9090/api/v1/alerts | node -e '
    let s = "";
    process.stdin.on("data", (d) => (s += d)).on("end", () => {
      const mine = JSON.parse(s).data.alerts.filter((a) => a.labels.alertname === process.argv[1]);
      console.log(mine.some((a) => a.state === "firing") ? "firing" : mine.length ? "pending" : "inactive");
    });' "$1"
}
# Wait until alert $1 is in state $2, at most $3 seconds.
await() {
  local deadline=$(($(date +%s) + $3))
  until [ "$(state "$1")" = "$2" ]; do
    if [ "$(date +%s)" -ge "$deadline" ]; then log "FAILED: $1 still not $2 after $3 s"; exit 1; fi
    sleep 5
  done
  log "$1 $2"
}
# The slot's WAL as a share of the cap, in %: retained / (retained + safe), the alerts' own formula.
share() {
  sql "SELECT floor(100 * r / (r + s))::int FROM (SELECT pg_wal_lsn_diff(pg_current_wal_lsn(), restart_lsn) AS r,
       safe_wal_size AS s FROM pg_replication_slots WHERE slot_name = 'driftless_slot') x"
}
grow_to() {
  while [ "$(share)" -lt "$1" ]; do
    sql "SELECT pg_logical_emit_message(false, 'driftless-alert-drill', repeat('x', 4000000)) FROM generate_series(1, 2)" >/dev/null
  done
  log "slot WAL at $(share) % of the cap ($(sql "SELECT wal_status FROM pg_replication_slots WHERE slot_name = 'driftless_slot'"))"
}
connector_up() {
  # --no-deps: otherwise compose recreates a dependency whose config differs from its model, which put the slot phase's
  # Postgres straight back to the 1 GB cap on the first run.
  docker compose up -d --no-deps connector >/dev/null 2>&1
  sleep 15 # started and scraped at least twice
}

case "$phase" in
  down)
    connector_up
    await DriftlessDown inactive 60
    docker compose kill -s SIGKILL connector >/dev/null 2>&1
    log "connector SIGKILLed (a docker kill counts as a manual stop: it stays down)"
    await DriftlessDown pending 60
    await DriftlessDown firing 240
    sleep "$hold"
    connector_up
    log "connector started again"
    await DriftlessDown inactive 120
    ;;

  stalled)
    rate=${2:-200}
    connector_up
    workload_log=$(mktemp)
    scripts/workload.sh "$rate" 600 > "$workload_log" 2>&1 &
    workload=$!
    sleep 20
    await DriftlessStalled inactive 5
    docker compose pause meilisearch >/dev/null 2>&1
    log "meilisearch frozen under $rate tx/s"
    await DriftlessStalled pending 240
    await DriftlessStalled firing 360
    sleep "$hold"
    docker compose unpause meilisearch >/dev/null 2>&1
    log "meilisearch unfrozen"
    await DriftlessStalled inactive 300
    wait "$workload"
    grep -E '^number of (transactions actually processed|failed transactions)' "$workload_log" | sed 's/^/  workload: /' || true
    node scripts/reconcile.ts --timeout=900
    ;;

  slot)
    rate=${2:-50}
    PG_MAX_SLOT_WAL_KEEP_SIZE=256MB docker compose up -d --wait postgres >/dev/null 2>&1
    connector_up # it lost its connection with the old Postgres and restarted (fail-stop, D-009)
    cap=$(sql 'SHOW max_slot_wal_keep_size')
    log "cap $cap; slot WAL at $(share) % of it"
    [ "$cap" = 256MB ] || { log "FAILED: the cap should be 256MB"; exit 1; }
    workload_log=$(mktemp)
    scripts/workload.sh "$rate" 720 > "$workload_log" 2>&1 &
    workload=$!
    sleep 15
    docker compose pause meilisearch >/dev/null 2>&1
    log "meilisearch frozen under $rate tx/s: nothing is confirmed, so the slot keeps all new WAL"
    grow_to 60
    await DriftlessSlotWalHigh pending 60
    await DriftlessSlotWalHigh firing 420
    grow_to 85
    await DriftlessSlotWalCritical pending 60
    await DriftlessSlotWalCritical firing 180
    log "slot WAL at $(share) % of the cap"
    sleep "$hold"
    docker compose unpause meilisearch >/dev/null 2>&1
    log "meilisearch unfrozen"
    await DriftlessSlotWalCritical inactive 300
    await DriftlessSlotWalHigh inactive 300
    wait "$workload"
    grep -E '^number of (transactions actually processed|failed transactions)' "$workload_log" | sed 's/^/  workload: /' || true
    node scripts/reconcile.ts --timeout=900
    docker compose up -d --wait postgres >/dev/null 2>&1 # back to the default cap (1GB)
    connector_up
    log "cap back to $(sql 'SHOW max_slot_wal_keep_size'); slot $(sql "SELECT wal_status FROM pg_replication_slots WHERE slot_name = 'driftless_slot'")"
    ;;

  *) echo "usage: scripts/alert-drill.sh down|stalled|slot [RATE_TX_PER_S]" >&2; exit 2 ;;
esac
log "done"
