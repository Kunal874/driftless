import { createServer, type Server } from 'node:http';
import { Counter, Gauge, Histogram, Registry, collectDefaultMetrics } from 'prom-client';

// Prometheus metrics (T09), served as plain text at GET /metrics. Prometheus scrapes it every few seconds;
// Grafana draws it (docker/grafana/).
export const registry = new Registry();
collectDefaultMetrics({ register: registry, prefix: 'driftless_' }); // memory, CPU, event-loop delay, …

// "How stale can search be?" From a transaction's commit in Postgres until every change in it has been applied in
// Meilisearch AND everything before it has too, i.e. until it can be confirmed. Both clocks are the same machine's
// when both run in Docker; a connector on the Windows host compares against the Docker VM's clock.
export const lag = new Histogram({
  name: 'driftless_lag_seconds',
  help: 'Commit in Postgres until applied in Meilisearch and confirmable',
  // Fine between 0.5 and 10 s, where lag actually lives on this setup (T09.3), so p99 is more than "2.5–5 s".
  buckets: [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 0.75, 1, 1.25, 1.5, 1.75, 2, 2.5, 3, 3.5, 4, 5, 6, 8, 10, 15,
    30, 60, 120, 300, 600],
  registers: [registry],
});

export const changesApplied = new Counter({
  name: 'driftless_changes_applied_total',
  help: 'Row changes applied to Meilisearch, by operation',
  labelNames: ['op'] as const,
  registers: [registry],
});

// One lane write to one sink (label `sink`): from sending the batch until that sink has applied it, retries included.
// A batch is applied once its slowest sink is done. Most of the lag is that, twice: a transaction usually waits for
// its lane's current write, then rides the next one.
export const writeSeconds = new Histogram({
  name: 'driftless_write_seconds',
  help: 'One lane write to one sink, until that sink has applied it',
  labelNames: ['sink'] as const,
  buckets: [0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 0.75, 1, 1.25, 1.5, 2, 2.5, 3, 4, 5, 10, 30, 60],
  registers: [registry],
});

export const batchSize = new Histogram({
  name: 'driftless_batch_changes',
  help: 'Changes per lane batch (natural batching, D-022)',
  buckets: [1, 2, 5, 10, 25, 50, 100, 250, 500, 1000, 2500, 5000],
  registers: [registry],
});

// A value that already lives elsewhere (e.g. in main.ts), read at scrape time instead of copied around.
export function gaugeOf(name: string, help: string, read: () => number | Promise<number>): void {
  new Gauge({
    name,
    help,
    registers: [registry],
    async collect() {
      this.set(await read());
    },
  });
}

export function serveMetrics(host: string, port: number): Server {
  return createServer((req, res) => {
    if (req.url !== '/metrics') {
      res.writeHead(404).end();
      return;
    }
    registry.metrics().then(
      (text) => res.writeHead(200, { 'Content-Type': registry.contentType }).end(text),
      (err: unknown) => res.writeHead(500).end(String(err)),
    );
  }).listen(port, host);
}
