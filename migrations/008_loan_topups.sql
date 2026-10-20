-- A top-up is a new loan that clears an existing one when it is paid out (By-law: treated as a new application).
ALTER TABLE loans ADD COLUMN topup_of INTEGER REFERENCES loans(id);
