// End-to-end lag at a fixed write rate (T09.3).
//
// Usage: node scripts/bench-lag.ts RATE [SECONDS=60] [CLIENTS=4]
//
// Expects the connector running in Docker (metrics on 127.0.0.1:9464) and caught up. Snapshots GET /metrics,
// runs the standard workload (scripts/workload.sh) at RATE tx/s, samples the queue gauges every second, waits
// until Driftless has caught up, snapshots again, and computes everything from the difference, so earlier runs
// don't leak in. Quantiles are interpolated within histogram buckets, the same way Prometheus's
// histogram_quantile does.
import { execFileSync, spawn } from 'node:child_process';
import { setTimeout as sleep } from 'node:timers/promises';

const METRICS_URL = 'http://127.0.0.1:9464/metrics';
const CATCH_UP_TIMEOUT_MS = 600_000;

type Snapshot = Map<string, number>; // series ("name{labels}") → value

async function scrape(): Promise<Snapshot> {
  const text = await (await fetch(METRICS_URL)).text();
  const snap: Snapshot = new Map();
  for (const line of text.split('\n')) {
    if (!line || line.startsWith('#')) continue;
    const at = line.lastIndexOf(' ');
    snap.set(line.slice(0, at), Number(line.slice(at + 1)));
  }
  return snap;
}

const idle = (s: Snapshot) => s.get('driftless_txns_in_flight') === 0 && s.get('driftless_changes_waiting') === 0;

// Buckets of one histogram as counts added between two snapshots, sorted by upper bound (le).
function bucketDeltas(name: string, before: Snapshot, after: Snapshot): Array<{ le: number; n: number }> {
  const prefix = `${name}_bucket{le="`;
  return [...after.keys()]
    .filter((k) => k.startsWith(prefix))
    .map((k) => {
      const le = k.slice(prefix.length, -2);
      return { le: le === '+Inf' ? Infinity : Number(le), n: after.get(k)! - (before.get(k) ?? 0) };
    })
    .sort((a, b) => a.le - b.le);
}

function quantile(q: number, buckets: Array<{ le: number; n: number }>): number {
  const total = buckets.at(-1)?.n ?? 0;
  if (total === 0) return NaN;
  const rank = q * total;
  let prevLe = 0;
  let prevN = 0;
  for (const { le, n } of buckets) {
    if (n >= rank) {
      if (le === Infinity) return prevLe; // like Prometheus: no upper bound to interpolate towards
      return prevLe + ((le - prevLe) * (rank - prevN)) / (n - prevN);
    }
    prevLe = le;
    prevN = n;
  }
  return NaN;
}

// The smallest bucket bound every observation fits under: "max ≤ this".
const maxBound = (buckets: Array<{ le: number; n: number }>) => buckets.find((b) => b.n === buckets.at(-1)!.n)?.le;

const delta = (name: string, before: Snapshot, after: Snapshot) => (after.get(name) ?? 0) - (before.get(name) ?? 0);

const [rate = '200', seconds = '60', clients = '4'] = process.argv.slice(2);
const env = execFileSync('docker', ['compose', 'exec', '-T', 'connector', 'printenv', 'DRIFTLESS_LANES', 'DRIFTLESS_BATCH_MAX'])
  .toString().trim().split(/\s+/);
console.log(`bench-lag: ${rate} tx/s for ${seconds} s, ${clients} clients; connector lanes=${env[0]} batchMax=${env[1]}`);

while (!idle(await scrape())) await sleep(500); // start from a caught-up connector
const before = await scrape();

const workload = spawn('bash', ['scripts/workload.sh', rate, seconds, clients]);
let pgbench = '';
workload.stdout.on('data', (d: Buffer) => (pgbench += d));
workload.stderr.on('data', (d: Buffer) => process.stderr.write(d));
const exited = new Promise<number | null>((resolve) => workload.on('close', resolve));

let running = true;
void exited.then(() => (running = false));
let maxWaiting = 0;
let maxInFlight = 0;
let pausedSamples = 0;
while (running) {
  const s = await scrape();
  maxWaiting = Math.max(maxWaiting, s.get('driftless_changes_waiting') ?? 0);
  maxInFlight = Math.max(maxInFlight, s.get('driftless_txns_in_flight') ?? 0);
  if (s.get('driftless_reading_paused') === 1) pausedSamples++;
  await sleep(1000);
}
if ((await exited) !== 0) throw new Error('workload failed');

const stoppedAt = Date.now();
let after = await scrape();
while (!idle(after)) {
  if (Date.now() - stoppedAt > CATCH_UP_TIMEOUT_MS) throw new Error('not caught up after 10 min');
  await sleep(100);
  after = await scrape();
}
const catchUpS = (Date.now() - stoppedAt) / 1000;

const lag = bucketDeltas('driftless_lag_seconds', before, after);
const write = bucketDeltas('driftless_write_seconds', before, after);
const txns = lag.at(-1)?.n ?? 0;
const writes = delta('driftless_batch_changes_count', before, after);
const changes = delta('driftless_batch_changes_sum', before, after);
const tps = pgbench.match(/tps = ([\d.]+)/)?.[1] ?? '?';
const scheduleLag = pgbench.match(/rate limit schedule lag: avg ([\d.]+)/)?.[1] ?? '?';
const s2 = (x: number) => (Number.isNaN(x) ? '–' : x.toFixed(2));

console.log(`pgbench: ${tps} tx/s achieved (schedule lag avg ${scheduleLag} ms)`);
console.log(`applied: ${txns} txns with changes, ${changes} changes in ${writes} writes (${(changes / writes).toFixed(1)}/write)`);
console.log(`lag: p50 ${s2(quantile(0.5, lag))} s, p95 ${s2(quantile(0.95, lag))} s, p99 ${s2(quantile(0.99, lag))} s, ` +
  `max ≤ ${maxBound(lag)} s`);
console.log(`one write: p50 ${s2(quantile(0.5, write))} s, p99 ${s2(quantile(0.99, write))} s`);
console.log(`during the run: max ${maxWaiting} changes waiting, max ${maxInFlight} txns in flight, reading paused in ` +
  `${pausedSamples} 1-s samples; caught up ${catchUpS.toFixed(1)} s after the load stopped`);
console.log(`row: | ${rate} | ${tps} | ${env[0]} / ${env[1]} | ${s2(quantile(0.5, lag))} | ${s2(quantile(0.95, lag))} | ` +
  `${s2(quantile(0.99, lag))} | ${s2(quantile(0.5, write))} | ${(changes / writes).toFixed(0)} | ${maxWaiting} | ` +
  `${catchUpS.toFixed(1)} s |`);
