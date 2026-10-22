import type { Row } from '../source/decode.ts';

export type Document = Record<string, unknown>;

// One row → one search document. This is the only definition of the document's shape: the sink writes it,
// and reconcile (T05) compares Postgres against it (D-020).
// - A Date becomes its ISO-8601 string (exact, sortable, readable).
// - bigint ids are already exact strings, because `pg` parses int8 as text.
// - Only columns present in the row appear. An update whose big unchanged (TOAST) columns weren't sent
//   gives a partial document, which Meilisearch merges into the existing one.
// - Only columns `keep` accepts appear (the config file's sync.columns, T10.1).
export function toDocument(row: Row, keep: (column: string) => boolean = () => true): Document {
  return Object.fromEntries(
    Object.entries(row)
      .filter(([column]) => keep(column))
      .map(([column, value]) => [column, value instanceof Date ? value.toISOString() : value]),
  );
}
