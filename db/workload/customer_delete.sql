-- Deletes a random customer (`multi` mix, T13). An id that's already gone matches 0 rows.
\set id random(1, :maxcid)
DELETE FROM customers WHERE id = :id;
