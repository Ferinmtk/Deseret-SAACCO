-- Initial schema for the member portal and staff admin.

CREATE TABLE settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  label TEXT,
  position SERIAL
);

CREATE TABLE staff (
  id SERIAL PRIMARY KEY,
  name TEXT NOT NULL,
  email TEXT UNIQUE NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('clerk','credit','manager','treasurer','board')),
  password_hash TEXT NOT NULL,
  last_login TIMESTAMP(0)
);

CREATE TABLE members (
  id SERIAL PRIMARY KEY,
  member_no TEXT UNIQUE,
  first_name TEXT NOT NULL,
  last_name TEXT NOT NULL,
  id_number TEXT NOT NULL,
  kra_pin TEXT,
  phone TEXT NOT NULL,
  email TEXT,
  date_of_birth DATE,
  address TEXT,
  office_phone TEXT,
  employer TEXT,
  department TEXT,
  designation TEXT,
  terms TEXT NOT NULL DEFAULT 'permanent' CHECK (terms IN ('permanent','contract','not employed')),
  contract_end DATE,
  payroll_no TEXT,
  ward TEXT,
  bank_name TEXT,
  bank_branch TEXT,
  bank_account TEXT,
  net_salary INTEGER NOT NULL DEFAULT 0,
  admission_minute TEXT,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','active','exiting','exited','rejected')),
  joined_at DATE,
  exit_notice_at DATE,
  password_hash TEXT,
  last_login TIMESTAMP(0),
  created_by INTEGER REFERENCES staff(id),
  approved_by INTEGER REFERENCES staff(id),
  created_at TIMESTAMP(0) NOT NULL DEFAULT now()
);

CREATE TABLE nominees (
  id SERIAL PRIMARY KEY,
  member_id INTEGER NOT NULL REFERENCES members(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  relationship TEXT NOT NULL,
  id_number TEXT,
  phone TEXT,
  address TEXT,
  share_pct INTEGER NOT NULL
);

-- Member requests that need staff action, e.g. the "Authority to vary deductions" form.
CREATE TABLE requests (
  id SERIAL PRIMARY KEY,
  member_id INTEGER NOT NULL REFERENCES members(id),
  type TEXT NOT NULL CHECK (type IN ('deduction_change')),
  details TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','approved','rejected')),
  handled_by INTEGER REFERENCES staff(id),
  created_at TIMESTAMP(0) NOT NULL DEFAULT now()
);

CREATE TABLE goals (
  member_id INTEGER NOT NULL REFERENCES members(id) ON DELETE CASCADE,
  account TEXT NOT NULL,
  target INTEGER NOT NULL,
  target_date DATE NOT NULL,
  PRIMARY KEY (member_id, account)
);

CREATE TABLE loan_products (
  code TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  description TEXT,
  rate_monthly DOUBLE PRECISION NOT NULL,
  method TEXT NOT NULL CHECK (method IN ('reducing','flat')),
  max_months INTEGER NOT NULL,
  multiplier DOUBLE PRECISION NOT NULL,
  min_guarantors INTEGER NOT NULL,
  fee_pct DOUBLE PRECISION NOT NULL,
  max_salary_pct INTEGER,
  position SERIAL
);

-- A payment is money received (M-Pesa, bank, standing order, check-off, cash).
-- It is split into one or more transactions, so members can see where every shilling went.
CREATE TABLE payments (
  id SERIAL PRIMARY KEY,
  member_id INTEGER NOT NULL REFERENCES members(id),
  amount INTEGER NOT NULL,
  channel TEXT NOT NULL CHECK (channel IN ('mpesa','bank','standing','checkoff','cash')),
  reference TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','posted','rejected')),
  created_by INTEGER REFERENCES staff(id),
  approved_by INTEGER REFERENCES staff(id),
  submitted_by_member BOOLEAN NOT NULL DEFAULT false,
  note TEXT,
  created_at TIMESTAMP(0) NOT NULL DEFAULT now()
);

CREATE TABLE loans (
  id SERIAL PRIMARY KEY,
  member_id INTEGER NOT NULL REFERENCES members(id),
  product TEXT NOT NULL REFERENCES loan_products(code),
  principal INTEGER NOT NULL,
  months INTEGER NOT NULL,
  rate_monthly DOUBLE PRECISION NOT NULL,
  method TEXT NOT NULL,
  installment INTEGER NOT NULL,
  total_payable INTEGER NOT NULL,
  fee INTEGER NOT NULL DEFAULT 0,
  purpose TEXT,
  status TEXT NOT NULL CHECK (status IN ('guarantors','appraisal','recommended','approved','disbursed','closed','rejected')),
  applied_at TIMESTAMP(0) NOT NULL,
  recommended_by INTEGER REFERENCES staff(id),
  approved_by INTEGER REFERENCES staff(id),
  disbursed_by INTEGER REFERENCES staff(id),
  disbursed_at DATE,
  reject_reason TEXT
);

CREATE TABLE guarantees (
  id SERIAL PRIMARY KEY,
  loan_id INTEGER NOT NULL REFERENCES loans(id) ON DELETE CASCADE,
  guarantor_id INTEGER NOT NULL REFERENCES members(id),
  amount INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','accepted','declined')),
  requested_at TIMESTAMP(0) NOT NULL,
  responded_at TIMESTAMP(0),
  UNIQUE (loan_id, guarantor_id)
);

-- account: shares | deposits | holiday | family | loan
CREATE TABLE transactions (
  id SERIAL PRIMARY KEY,
  member_id INTEGER NOT NULL REFERENCES members(id),
  payment_id INTEGER REFERENCES payments(id),
  loan_id INTEGER REFERENCES loans(id),
  account TEXT NOT NULL,
  amount INTEGER NOT NULL,
  description TEXT NOT NULL,
  created_at TIMESTAMP(0) NOT NULL
);

CREATE TABLE loan_events (
  id SERIAL PRIMARY KEY,
  loan_id INTEGER NOT NULL REFERENCES loans(id) ON DELETE CASCADE,
  step TEXT NOT NULL,
  actor TEXT NOT NULL,
  note TEXT,
  created_at TIMESTAMP(0) NOT NULL
);

CREATE TABLE audit (
  id SERIAL PRIMARY KEY,
  actor TEXT NOT NULL,
  action TEXT NOT NULL,
  entity TEXT,
  entity_id INTEGER,
  details TEXT,
  created_at TIMESTAMP(0) NOT NULL DEFAULT now()
);

-- Login sessions (connect-pg-simple), so sign-ins survive restarts and work across servers.
CREATE TABLE session (
  sid VARCHAR NOT NULL PRIMARY KEY,
  sess JSON NOT NULL,
  expire TIMESTAMP(6) NOT NULL
);

CREATE INDEX transactions_member_idx ON transactions (member_id, account);
CREATE INDEX transactions_loan_idx ON transactions (loan_id);
CREATE INDEX payments_member_idx ON payments (member_id);
CREATE INDEX loans_member_idx ON loans (member_id);
CREATE INDEX guarantees_guarantor_idx ON guarantees (guarantor_id);
CREATE INDEX session_expire_idx ON session (expire);
