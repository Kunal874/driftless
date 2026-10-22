import { describe, expect, it } from 'vitest';
import { bigIntToLsn, lsnToBigInt } from './lsn.ts';

describe('lsn', () => {
  it('reads the padded and the short form', () => {
    expect(lsnToBigInt('00000000/09D68A48')).toBe(0x09d68a48n);
    expect(lsnToBigInt('0/9D68A48')).toBe(0x09d68a48n);
    expect(lsnToBigInt('16/B374D848')).toBe((0x16n << 32n) | 0xb374d848n);
  });

  it('round-trips, including across the 32-bit boundary', () => {
    for (const lsn of ['0/0', '0/FFFFFFFF', '1/0', 'FFFFFFFF/FFFFFFFF']) {
      expect(bigIntToLsn(lsnToBigInt(lsn))).toBe(lsn);
    }
    // end − 1 (the BUG-001 compensation) must borrow from the high half correctly
    expect(bigIntToLsn(lsnToBigInt('1/0') - 1n)).toBe('0/FFFFFFFF');
  });

  it('rejects malformed or out-of-range values', () => {
    expect(() => lsnToBigInt('1A2B')).toThrow(/not an LSN/);
    expect(() => bigIntToLsn(-1n)).toThrow(/out of range/);
  });
});
