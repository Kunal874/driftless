-- One transaction touching BOTH tables (`multi` mix, T13): a customer's order changes a product's stock and the
-- customer's record together. Driftless may confirm it only once both changes are applied, in every sink.
\set pid random(1, :maxid)
\set cid random(1, :maxcid)
\set stock random(0, 499)
BEGIN;
UPDATE products SET stock = :stock, updated_at = now() WHERE id = :pid;
UPDATE customers SET updated_at = now() WHERE id = :cid;
COMMIT;
