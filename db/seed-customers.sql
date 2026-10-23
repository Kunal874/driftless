-- Seed `customers` with :rows rows (default 20000). Re-runnable: it empties the table first.
-- Separate from seed.sql on purpose: the products seed stays exactly as it was (D-016), so earlier numbers stay
-- comparable. Run from the repo root (Git Bash on Windows: prefix with MSYS_NO_PATHCONV=1):
--   docker compose exec -T postgres psql -U driftless -d shop -v rows=20000 -f /db/seed-customers.sql
\set ON_ERROR_STOP on
\if :{?rows}
\else
  \set rows 20000
\endif

SELECT setseed(0.43);

TRUNCATE customers RESTART IDENTITY;

INSERT INTO customers (name, email, city)
SELECT
  (ARRAY['Asha', 'Ravi', 'Meera', 'Kabir', 'Isha', 'Arjun', 'Zara', 'Vikram',
         'Nina', 'Omar', 'Priya', 'Leo', 'Sara', 'Dev', 'Anya', 'Rohan'])[1 + floor(random() * 16)::int]
    || ' ' ||
  (ARRAY['Sharma', 'Patel', 'Iyer', 'Khan', 'Reddy', 'Das', 'Gupta', 'Nair'])[1 + floor(random() * 8)::int],
  'customer' || g || '@example.test',
  (ARRAY['Mumbai', 'Delhi', 'Bengaluru', 'Pune', 'Chennai', 'Hyderabad', 'Kolkata', 'Jaipur'])[1 + floor(random() * 8)::int]
FROM generate_series(1, :rows) AS g;

ANALYZE customers;

SELECT count(*) AS customers FROM customers;
