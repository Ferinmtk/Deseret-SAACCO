-- Fields from the paper "Application for Membership" form, so members can apply online.
ALTER TABLE members ADD COLUMN title TEXT;
ALTER TABLE members ADD COLUMN monthly_contribution INTEGER;
ALTER TABLE members ADD COLUMN source TEXT NOT NULL DEFAULT 'office' CHECK (source IN ('office','online'));
ALTER TABLE members ADD COLUMN declared_at TIMESTAMP(0);
ALTER TABLE nominees ADD COLUMN witness TEXT;
