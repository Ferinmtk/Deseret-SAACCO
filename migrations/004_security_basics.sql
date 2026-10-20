-- Failed sign-in tracking (works across serverless instances) and first-login password change.
CREATE TABLE login_attempts (
  key TEXT PRIMARY KEY,           -- 'member:DS0001', 'staff:email', or 'ip:1.2.3.4'
  failures INTEGER NOT NULL DEFAULT 0,
  first_failed_at TIMESTAMP(0) NOT NULL DEFAULT now(),
  locked_until TIMESTAMP(0)
);
ALTER TABLE members ADD COLUMN must_change_password BOOLEAN NOT NULL DEFAULT false;
