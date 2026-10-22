// Decides how far Driftless may confirm to Postgres once transactions are applied in parallel lanes.
//
// Transactions are tracked in commit order. Each one counts down its changes as lanes apply them, possibly
// out of order: a small transaction on a fast lane can finish before a big one on a slow lane. Confirming
// that small one would tell Postgres the big one is done too (a confirm covers everything before it), so a
// crash would lose it. The rule: confirm only the end of the longest unbroken run of fully applied
// transactions, counted from the oldest one.
export type Tracked = { endLsn: bigint; remaining: number; committedAt: number };

export class Checkpointer {
  #txns: Tracked[] = [];
  #head = 0; // index of the oldest transaction not yet confirmable
  #onConfirmable: (txn: Tracked) => void;

  // `onConfirmable` sees each transaction as it becomes confirmable: where the lag metric is measured (T09).
  constructor(onConfirmable: (txn: Tracked) => void = () => {}) {
    this.#onConfirmable = onConfirmable;
  }

  track(endLsn: bigint, changes: number, committedAt = Date.now()): Tracked {
    const txn = { endLsn, remaining: changes, committedAt };
    this.#txns.push(txn);
    return txn;
  }

  // The end LSN of the unbroken run of fully applied transactions, if that run just grew; else undefined.
  advance(): bigint | undefined {
    let end: bigint | undefined;
    while (this.#head < this.#txns.length && this.#txns[this.#head]!.remaining === 0) {
      const txn = this.#txns[this.#head]!;
      this.#onConfirmable(txn);
      end = txn.endLsn;
      this.#head++;
    }
    if (this.#head > 1024 && this.#head * 2 > this.#txns.length) {
      this.#txns = this.#txns.slice(this.#head); // drop confirmed history so memory stays flat
      this.#head = 0;
    }
    return end;
  }

  // Transactions received but not yet confirmable: 0 means everything received has been applied.
  get inFlight(): number {
    return this.#txns.length - this.#head;
  }
}
