#!/usr/bin/env bash
# Random write workload against public.products at a fixed rate, run by pgbench inside the
# postgres container. This is the ONLY definition of the mix (D-016): T02 checks, T05 chaos runs
# and T09 benchmarks all call this script, so their numbers stay comparable.
#
# Usage: [WORKLOAD_MIX=products|multi] scripts/workload.sh [RATE_TX_PER_SEC=200] [SECONDS=30] [CLIENTS=4]
#   products (default, unchanged since T02): products only.
#   multi (T13): the products mix plus customers, and transactions that change one row of each.
set -euo pipefail
export MSYS_NO_PATHCONV=1 # Git Bash: don't rewrite /db/... into a Windows path
cd "$(dirname "$0")/.."

rate=${1:-200}
seconds=${2:-30}
clients=${3:-4}

sql() { docker compose exec -T postgres psql -U driftless -d shop -tAc "$1"; }

maxid=$(sql "SELECT coalesce(max(id), 0) FROM products")
if [ "$maxid" -eq 0 ]; then
  echo "workload: products is empty; seed it first (db/seed.sql)" >&2
  exit 1
fi

# Products mix: 60% price/stock updates (big descriptions untouched -> unchanged-TOAST case),
# 20% description rewrites, 10% inserts, 10% deletes.
mix=(--define=maxid="$maxid"
  --file=/db/workload/update_price.sql@6
  --file=/db/workload/update_desc.sql@2
  --file=/db/workload/insert.sql@1
  --file=/db/workload/delete.sql@1)

# Multi mix (T13), added on top, in weight units of the same scale (products 10, customers 5, both 2):
# customer updates, inserts and deletes, and cross-table transactions (a product and a customer in one commit).
if [ "${WORKLOAD_MIX:-products}" = multi ]; then
  maxcid=$(sql "SELECT coalesce(max(id), 0) FROM customers")
  if [ "$maxcid" -eq 0 ]; then
    echo "workload: customers is empty; seed it first (db/seed-customers.sql)" >&2
    exit 1
  fi
  mix+=(--define=maxcid="$maxcid"
    --file=/db/workload/customer_update.sql@3
    --file=/db/workload/customer_insert.sql@1
    --file=/db/workload/customer_delete.sql@1
    --file=/db/workload/cross_table.sql@2)
elif [ "${WORKLOAD_MIX:-products}" != products ]; then
  echo "workload: unknown WORKLOAD_MIX '${WORKLOAD_MIX}' (products or multi)" >&2
  exit 1
fi

docker compose exec -T postgres pgbench -n -U driftless \
  --client="$clients" --jobs="$clients" --rate="$rate" --time="$seconds" \
  "${mix[@]}" \
  shop
