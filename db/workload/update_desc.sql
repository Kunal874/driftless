-- Rewrites the description: 1 in 20 becomes big (~2.5 KB, stored out-of-line), the rest small.
\set id random(1, :maxid)
\set big random(1, 20)
UPDATE products
SET description = CASE WHEN :big = 1
                       THEN (SELECT string_agg(md5(random()::text), '') FROM generate_series(1, 80))
                       ELSE 'Updated description ' || md5(random()::text)
                  END,
    updated_at = now()
WHERE id = :id;
