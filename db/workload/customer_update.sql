-- A customer moves or renames (`multi` mix, T13).
\set id random(1, :maxcid)
UPDATE customers
SET city = (ARRAY['Mumbai', 'Delhi', 'Bengaluru', 'Pune', 'Chennai', 'Hyderabad', 'Kolkata', 'Jaipur'])[1 + floor(random() * 8)::int],
    name = name || '', -- touched, unchanged: an update that rewrites a column with the same value
    updated_at = now()
WHERE id = :id;
