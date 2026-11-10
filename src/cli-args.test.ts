import { describe, expect, it } from 'vitest';
import { parseCli } from './cli-args.ts';

describe('parseCli', () => {
  it('runs the connector by default', () => {
    expect(parseCli([])).toEqual({ run: 'connector', config: undefined, timeoutS: 600 });
    expect(parseCli(['--config', 'prod.json'])).toEqual({ run: 'connector', config: 'prod.json', timeoutS: 600 });
  });

  it('reconciles, with an optional timeout', () => {
    expect(parseCli(['reconcile'])).toEqual({ run: 'reconcile', config: undefined, timeoutS: 600 });
    expect(parseCli(['reconcile', '--timeout', '30', '--config=a.json'])).toEqual({ run: 'reconcile', config: 'a.json', timeoutS: 30 });
  });

  it('answers --help and --version before anything else', () => {
    expect(parseCli(['reconcile', '--help'])).toEqual({ run: 'help' });
    expect(parseCli(['--version'])).toEqual({ run: 'version' });
  });

  it('refuses the self-test: it plants drift, so it stays in the repo script', () => {
    expect(() => parseCli(['reconcile', '--self-test'])).toThrow(/self-test/);
  });

  it('refuses unknown commands, extra words and bad timeouts', () => {
    expect(() => parseCli(['backfill'])).toThrow('unknown command: backfill');
    expect(() => parseCli(['reconcile', 'now'])).toThrow('unknown command: reconcile now');
    expect(() => parseCli(['--timeout', '30'])).toThrow('only applies to reconcile');
    expect(() => parseCli(['reconcile', '--timeout', 'soon'])).toThrow('above 0');
    expect(() => parseCli(['reconcile', '--timeout', '0'])).toThrow('above 0');
  });
});
