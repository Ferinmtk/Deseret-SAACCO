-- Officials: members who sit on the board or a committee. Their membership account is unchanged;
-- the tag only adds the by-law checks (BL65: no better loan terms, BL69: may not guarantee loans).
ALTER TABLE members ADD COLUMN official_role TEXT;

-- Leadership logins belong to the office, not the person: switch one off at handover, add one for the successor.
ALTER TABLE staff ADD COLUMN active BOOLEAN NOT NULL DEFAULT true;
ALTER TABLE staff ADD COLUMN must_change_password BOOLEAN NOT NULL DEFAULT false;
