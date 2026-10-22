-- A brand-new product. Postgres generates `id`; `sku` must be unique, hence the UUID.
\set n random(100, 999)
\set price random(99, 200098)
\set stock random(0, 499)
INSERT INTO products (sku, name, description, category, price_cents, stock)
VALUES ('SKU-' || gen_random_uuid(),
        'New Product ' || :n,
        'Freshly added product.',
        (ARRAY['electronics', 'home', 'kitchen', 'fashion', 'sports', 'books', 'toys', 'office'])[1 + floor(random() * 8)::int],
        :price, :stock);
