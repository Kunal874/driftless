-- A new customer (`multi` mix, T13). The email must be unique, hence the UUID.
INSERT INTO customers (name, email, city)
VALUES ('New Customer', 'new-' || gen_random_uuid() || '@example.test',
        (ARRAY['Mumbai', 'Delhi', 'Bengaluru', 'Pune'])[1 + floor(random() * 4)::int]);
