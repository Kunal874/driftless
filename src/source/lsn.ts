// An LSN (log sequence number) is a byte position in the WAL, written as two 32-bit hex halves,
// e.g. "0/71F31D8" or "00000000/071F31D8". BigInt makes comparing and adding to positions exact.
export function lsnToBigInt(lsn: string): bigint {
  const match = /^([0-9A-F]{1,8})\/([0-9A-F]{1,8})$/i.exec(lsn);
  if (!match) throw new Error(`not an LSN: '${lsn}'`);
  return (BigInt(`0x${match[1]}`) << 32n) | BigInt(`0x${match[2]}`);
}

export function bigIntToLsn(position: bigint): string {
  if (position < 0n || position >= 1n << 64n) throw new Error(`LSN out of range: ${position}`);
  return `${(position >> 32n).toString(16).toUpperCase()}/${(position & 0xffffffffn).toString(16).toUpperCase()}`;
}
