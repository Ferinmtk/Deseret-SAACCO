-- Nominee changes become requests the office confirms with two member witnesses (By-law 12).
ALTER TABLE requests DROP CONSTRAINT requests_type_check;
ALTER TABLE requests ADD CONSTRAINT requests_type_check CHECK (type IN ('deduction_change', 'nominee_change'));
