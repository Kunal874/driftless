-- A second demo table (T13: several tables per Driftless instance). Runs automatically on a fresh Postgres volume;
-- on an existing one, run it once by hand (it's idempotent):
--   docker compose exec -T postgres psql -U driftless -d shop -f /db/init/02-customers.sql
CREATE TABLE IF NOT EXISTS customers (
  id         bigint      GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  name       text        NOT NULL,
  email      text        NOT NULL UNIQUE,
  city       text        NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now()
);
