// The `driftless` command's arguments (T15, D-032), apart from src/cli.ts so they can be tested without running anything.
import { parseArgs } from 'node:util';

export const HELP = `Usage: driftless [reconcile] [options]

  driftless             run the connector: keep the configured indexes (and Redis cache) in sync with Postgres
  driftless reconcile   compare every row with every sink, read-only
                        (exit 0 = identical, 1 = drift, 2 = couldn't check)

Options:
  --config <file>       the config file (default: driftless.config.json here, or $DRIFTLESS_CONFIG)
  --timeout <seconds>   reconcile: how long to wait for Driftless to catch up first (default 600)
  --version, --help

Secrets come from the environment: PGPASSWORD, MEILI_MASTER_KEY, REDIS_PASSWORD.
Docs: https://github.com/Kunal874/driftless#readme`;

export type Command =
  | { run: 'help' }
  | { run: 'version' }
  | { run: 'connector' | 'reconcile'; config?: string; timeoutS: number };

// Pure, so it's unit-tested (cli.test.ts). Unknown options (e.g. reconcile's --self-test, which plants drift and is
// repo-only) are refused by parseArgs's strict mode.
export function parseCli(argv: string[]): Command {
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      config: { type: 'string' },
      timeout: { type: 'string' },
      version: { type: 'boolean' },
      help: { type: 'boolean' },
    },
  });
  if (values.help) return { run: 'help' };
  if (values.version) return { run: 'version' };
  const [command, ...rest] = positionals;
  if (rest.length > 0 || (command !== undefined && command !== 'reconcile')) {
    throw new Error(`unknown command: ${positionals.join(' ')}`);
  }
  if (values.timeout !== undefined && command !== 'reconcile') throw new Error('--timeout only applies to reconcile');
  const timeoutS = Number(values.timeout ?? 600);
  if (!(timeoutS > 0)) throw new Error(`--timeout must be a number of seconds above 0 (got ${values.timeout})`);
  return { run: command === 'reconcile' ? 'reconcile' : 'connector', config: values.config, timeoutS };
}
