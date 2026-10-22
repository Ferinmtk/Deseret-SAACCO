-- Where the last sign-in came from (rough town and device), so members and staff can spot one that wasn't them.
ALTER TABLE members ADD COLUMN last_login_from TEXT;
ALTER TABLE staff ADD COLUMN last_login_from TEXT;
