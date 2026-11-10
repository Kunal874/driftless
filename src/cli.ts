#!/usr/bin/env node
// The `driftless` command of the npm package driftless-cdc (T15, D-032). It only picks what to run: the connector
// (main.ts, which the repo and the image also run directly) or a read-only reconcile.
import { readFileSync } from 'node:fs';
import { HELP, parseCli } from './cli-args.ts';

const command = (() => {
  try {
    return parseCli(process.argv.slice(2));
  } catch (err) {
    console.error(`driftless: ${(err as Error).message}\n\n${HELP}`);
    return process.exit(2);
  }
})();
if (command.run === 'help') console.log(HELP);
else if (command.run === 'version') {
  console.log(JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version);
} else {
  // config.ts reads DRIFTLESS_CONFIG when it's first imported, so set it before importing anything that uses it.
  if (command.config) process.env.DRIFTLESS_CONFIG = command.config;
  if (command.run === 'connector') await import('./main.ts');
  else process.exitCode = await (await import('./reconcile.ts')).reconcile({ timeoutS: command.timeoutS });
}
