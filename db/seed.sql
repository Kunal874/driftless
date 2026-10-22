-- Seed `products` with :rows rows (default 100000). Re-runnable: it empties the table first.
-- Run from the repo root:
--   docker compose exec -T postgres psql -U driftless -d shop -v rows=100000 -f /db/seed.sql
-- From Git Bash on Windows, prefix it with MSYS_NO_PATHCONV=1 (see learn/task-02-source-data.md).
\set ON_ERROR_STOP on
\if :{?rows}
\else
  \set rows 100000
\endif

-- Same "random" data on every run, so benchmark runs stay comparable (D-016).
SELECT setseed(0.42);

TRUNCATE products RESTART IDENTITY;

INSERT INTO products (sku, name, description, category, price_cents, stock)
SELECT
  'SKU-' || lpad(g::text, 8, '0'),
  (ARRAY['Swift', 'Silent', 'Golden', 'Urban', 'Classic', 'Turbo', 'Nimble', 'Solar',
         'Arctic', 'Royal', 'Vivid', 'Smart', 'Ultra', 'Compact', 'Rugged', 'Prime'])[1 + floor(random() * 16)::int]
    || ' ' ||
  (ARRAY['Phone', 'Laptop', 'Headphones', 'Backpack', 'Kettle', 'Lamp', 'Keyboard', 'Mouse',
         'Watch', 'Camera', 'Speaker', 'Blender', 'Jacket', 'Sneakers', 'Bottle', 'Chair'])[1 + floor(random() * 16)::int]
    || ' ' || (100 + g % 900),
  CASE
    -- ~5% of rows: about 2.5 KB of random hex, big enough to be stored out-of-line (TOAST).
    -- The subquery mentions g, so it runs once per row (an uncorrelated one would run only once).
    WHEN random() < 0.05 THEN
      (SELECT string_agg(md5(g::text || ':' || i::text || random()::text), '')
       FROM generate_series(1, 80) AS i)
    ELSE 'Reliable everyday product, model ' || g || '.'
  END,
  (ARRAY['electronics', 'home', 'kitchen', 'fashion', 'sports', 'books', 'toys', 'office'])[1 + floor(random() * 8)::int],
  99 + floor(random() * 200000)::int,
  floor(random() * 500)::int
FROM generate_series(1, :rows) AS g;

ANALYZE products;

SELECT count(*)                                            AS rows,
       count(*) FILTER (WHERE length(description) > 2000)  AS big_descriptions,
       pg_size_pretty(pg_relation_size('products'))        AS table_size,
       pg_size_pretty(pg_relation_size(
         (SELECT reltoastrelid FROM pg_class WHERE relname = 'products'))) AS toast_size
FROM products;
