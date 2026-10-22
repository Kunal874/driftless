import type { Pgoutput } from 'pg-logical-replication';

export type Row = Record<string, unknown>;

export type Change =
  | { op: 'insert' | 'update'; table: string; pk: string; row: Row }
  | { op: 'delete'; table: string; pk: string }
  | { op: 'truncate'; tables: string[] };

export type Transaction = {
  xid: number;
  commitLsn: string; // where the commit record starts in the WAL
  commitEndLsn: string; // where it ends: the position Driftless confirms once the transaction is applied
  commitTime: Date;
  changes: Change[];
};

// Feed it pgoutput messages in stream order; at each COMMIT it returns the finished transaction.
export function transactionAssembler(): (msg: Pgoutput.Message) => Transaction | undefined {
  let open: { xid: number; changes: Change[] } | undefined;
  return (msg) => {
    switch (msg.tag) {
      case 'begin':
        if (open) throw new Error(`BEGIN of xid ${msg.xid} while xid ${open.xid} is still open`);
        open = { xid: msg.xid, changes: [] };
        return undefined;
      case 'insert':
      case 'update':
      case 'delete':
      case 'truncate':
        if (!open) throw new Error(`${msg.tag} outside a transaction`);
        open.changes.push(...toChanges(msg));
        return undefined;
      case 'commit': {
        if (!open) throw new Error('COMMIT without BEGIN');
        if (!msg.commitLsn || !msg.commitEndLsn) throw new Error(`COMMIT of xid ${open.xid} has no LSN`);
        const txn: Transaction = {
          xid: open.xid,
          commitLsn: msg.commitLsn,
          commitEndLsn: msg.commitEndLsn,
          commitTime: new Date(Number(msg.commitTime) / 1000), // microseconds → milliseconds
          changes: open.changes,
        };
        open = undefined;
        return txn;
      }
      default:
        return undefined; // relation / type / origin / message: nothing to apply
    }
  };
}

type DataMessage = Pgoutput.MessageInsert | Pgoutput.MessageUpdate | Pgoutput.MessageDelete | Pgoutput.MessageTruncate;

function toChanges(msg: DataMessage): Change[] {
  switch (msg.tag) {
    case 'insert':
      return [{ op: 'insert', table: tableName(msg.relation), pk: pkOf(msg.relation, msg.new), row: sent(msg.new) }];
    case 'update': {
      const table = tableName(msg.relation);
      const pk = pkOf(msg.relation, msg.new);
      const row = sent(msg.new);
      // The old row/key only comes along when the primary key changed, or with REPLICA IDENTITY FULL.
      const before = msg.key ?? msg.old;
      const oldPk = before ? pkOf(msg.relation, before) : pk;
      if (oldPk === pk) return [{ op: 'update', table, pk, row }];
      // The key changed: the old document must go and the new one needs every column. Unchanged TOAST
      // values weren't sent, and without REPLICA IDENTITY FULL there's no old row to copy them from.
      if (Object.keys(row).length < msg.relation.columns.length) {
        throw new Error(`${table}: key ${oldPk} → ${pk} changed with unsent TOAST columns; use REPLICA IDENTITY FULL`);
      }
      return [{ op: 'delete', table, pk: oldPk }, { op: 'insert', table, pk, row }];
    }
    case 'delete': {
      const before = msg.key ?? msg.old;
      if (!before) throw new Error(`${tableName(msg.relation)}: DELETE without key columns`);
      return [{ op: 'delete', table: tableName(msg.relation), pk: pkOf(msg.relation, before) }];
    }
    case 'truncate':
      return [{ op: 'truncate', tables: msg.relations.map(tableName) }];
  }
}

const tableName = (relation: Pgoutput.MessageRelation) => `${relation.schema}.${relation.name}`;

function pkOf(relation: Pgoutput.MessageRelation, tuple: Record<string, unknown>): string {
  const [key] = relation.keyColumns; // exactly one: checked at startup (replication.ts)
  const value = key === undefined ? undefined : tuple[key];
  if (value === undefined || value === null) throw new Error(`${tableName(relation)}: change without a primary-key value`);
  return String(value);
}

// pgoutput doesn't resend big values that didn't change (unchanged TOAST); the library turns them into
// `undefined`. Real SQL NULLs stay `null`. Keep only the columns that were actually sent.
function sent(tuple: Record<string, unknown>): Row {
  return Object.fromEntries(Object.entries(tuple).filter(([, value]) => value !== undefined));
}
