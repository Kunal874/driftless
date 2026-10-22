-- Demo source table for Driftless: the data the search index must mirror.
-- Runs automatically, once, when the Postgres volume is empty (docker-entrypoint-initdb.d).

CREATE TABLE products (
  id          bigint      GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  sku         text        NOT NULL UNIQUE,
  name        text        NOT NULL,
  description text,
  category    text        NOT NULL,
  price_cents integer     NOT NULL CHECK (price_cents >= 0),
  stock       integer     NOT NULL CHECK (stock >= 0),
  updated_at  timestamptz NOT NULL DEFAULT now()
);

-- Big descriptions are stored out-of-line (TOAST) and uncompressed. An UPDATE that doesn't
-- touch `description` doesn't write it to the WAL again, so logical decoding reports it as
-- "unchanged" instead of sending the value. Driftless must handle that (BUILD_PLAN T03/T04).
ALTER TABLE products ALTER COLUMN description SET STORAGE EXTERNAL;
