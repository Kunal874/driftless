-- Deletes a random product. An id that's already gone just matches 0 rows (still one transaction).
\set id random(1, :maxid)
DELETE FROM products WHERE id = :id;
