-- Price/stock change only. `description` is NOT touched, so when it's big (TOASTed) logical
-- decoding reports it as "unchanged" instead of sending it: the T04 pitfall this exercises.
\set id random(1, :maxid)
\set price random(99, 200098)
\set stock random(0, 499)
UPDATE products SET price_cents = :price, stock = :stock, updated_at = now() WHERE id = :id;
