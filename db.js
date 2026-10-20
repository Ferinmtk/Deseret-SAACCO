const { DatabaseSync } = require('node:sqlite');
const fs = require('fs');
const path = require('path');

const dataDir = path.join(__dirname, 'data');
fs.mkdirSync(dataDir, { recursive: true });

const db = new DatabaseSync(process.env.DB_PATH || path.join(dataDir, 'sacco.db'));
db.exec('PRAGMA foreign_keys = ON; PRAGMA journal_mode = WAL;');

db.exec(`
CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  label TEXT
);

CREATE TABLE IF NOT EXISTS staff (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL,
  email TEXT UNIQUE NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('clerk','credit','manager','treasurer','board')),
  password_hash TEXT NOT NULL,
  last_login TEXT
);

CREATE TABLE IF NOT EXISTS members (
  id INTEGER PRIMARY KEY,
  member_no TEXT UNIQUE,
  first_name TEXT NOT NULL,
  last_name TEXT NOT NULL,
  id_number TEXT NOT NULL,
  kra_pin TEXT,
  phone TEXT NOT NULL,
  email TEXT,
  date_of_birth TEXT,
  address TEXT,
  office_phone TEXT,
  employer TEXT,
  department TEXT,
  designation TEXT,
  terms TEXT NOT NULL DEFAULT 'permanent' CHECK (terms IN ('permanent','contract','not employed')),
  contract_end TEXT,
  payroll_no TEXT,
  ward TEXT,
  bank_name TEXT,
  bank_branch TEXT,
  bank_account TEXT,
  net_salary INTEGER NOT NULL DEFAULT 0,
  admission_minute TEXT,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','active','exiting','exited','rejected')),
  joined_at TEXT,
  exit_notice_at TEXT,
  password_hash TEXT,
  last_login TEXT,
  created_by INTEGER REFERENCES staff(id),
  approved_by INTEGER REFERENCES staff(id),
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS nominees (
  id INTEGER PRIMARY KEY,
  member_id INTEGER NOT NULL REFERENCES members(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  relationship TEXT NOT NULL,
  id_number TEXT,
  phone TEXT,
  address TEXT,
  share_pct INTEGER NOT NULL
);

-- Member requests that need staff action, e.g. the "Authority to vary deductions" form.
CREATE TABLE IF NOT EXISTS requests (
  id INTEGER PRIMARY KEY,
  member_id INTEGER NOT NULL REFERENCES members(id),
  type TEXT NOT NULL CHECK (type IN ('deduction_change')),
  details TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','approved','rejected')),
  handled_by INTEGER REFERENCES staff(id),
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS goals (
  member_id INTEGER NOT NULL REFERENCES members(id) ON DELETE CASCADE,
  account TEXT NOT NULL,
  target INTEGER NOT NULL,
  target_date TEXT NOT NULL,
  PRIMARY KEY (member_id, account)
);

CREATE TABLE IF NOT EXISTS loan_products (
  code TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  description TEXT,
  rate_monthly REAL NOT NULL,
  method TEXT NOT NULL CHECK (method IN ('reducing','flat')),
  max_months INTEGER NOT NULL,
  multiplier REAL NOT NULL,
  min_guarantors INTEGER NOT NULL,
  fee_pct REAL NOT NULL,
  max_salary_pct INTEGER
);

-- A payment is money received (M-Pesa, bank, check-off, cash).
-- It is split into one or more transactions, so members can see where every shilling went.
CREATE TABLE IF NOT EXISTS payments (
  id INTEGER PRIMARY KEY,
  member_id INTEGER NOT NULL REFERENCES members(id),
  amount INTEGER NOT NULL,
  channel TEXT NOT NULL CHECK (channel IN ('mpesa','bank','standing','checkoff','cash')),
  reference TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','posted','rejected')),
  created_by INTEGER REFERENCES staff(id),
  approved_by INTEGER REFERENCES staff(id),
  submitted_by_member INTEGER NOT NULL DEFAULT 0,
  note TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS loans (
  id INTEGER PRIMARY KEY,
  member_id INTEGER NOT NULL REFERENCES members(id),
  product TEXT NOT NULL REFERENCES loan_products(code),
  principal INTEGER NOT NULL,
  months INTEGER NOT NULL,
  rate_monthly REAL NOT NULL,
  method TEXT NOT NULL,
  installment INTEGER NOT NULL,
  total_payable INTEGER NOT NULL,
  fee INTEGER NOT NULL DEFAULT 0,
  purpose TEXT,
  status TEXT NOT NULL CHECK (status IN ('guarantors','appraisal','recommended','approved','disbursed','closed','rejected')),
  applied_at TEXT NOT NULL,
  recommended_by INTEGER REFERENCES staff(id),
  approved_by INTEGER REFERENCES staff(id),
  disbursed_by INTEGER REFERENCES staff(id),
  disbursed_at TEXT,
  reject_reason TEXT
);

CREATE TABLE IF NOT EXISTS guarantees (
  id INTEGER PRIMARY KEY,
  loan_id INTEGER NOT NULL REFERENCES loans(id) ON DELETE CASCADE,
  guarantor_id INTEGER NOT NULL REFERENCES members(id),
  amount INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','accepted','declined')),
  requested_at TEXT NOT NULL,
  responded_at TEXT,
  UNIQUE (loan_id, guarantor_id)
);

-- account: shares | deposits | holiday | family | loan
CREATE TABLE IF NOT EXISTS transactions (
  id INTEGER PRIMARY KEY,
  member_id INTEGER NOT NULL REFERENCES members(id),
  payment_id INTEGER REFERENCES payments(id),
  loan_id INTEGER REFERENCES loans(id),
  account TEXT NOT NULL,
  amount INTEGER NOT NULL,
  description TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS loan_events (
  id INTEGER PRIMARY KEY,
  loan_id INTEGER NOT NULL REFERENCES loans(id) ON DELETE CASCADE,
  step TEXT NOT NULL,
  actor TEXT NOT NULL,
  note TEXT,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS audit (
  id INTEGER PRIMARY KEY,
  actor TEXT NOT NULL,
  action TEXT NOT NULL,
  entity TEXT,
  entity_id INTEGER,
  details TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
`);

const one = (sql, ...params) => db.prepare(sql).get(...params);
const all = (sql, ...params) => db.prepare(sql).all(...params);
const run = (sql, ...params) => db.prepare(sql).run(...params);

function tx(fn) {
  db.exec('BEGIN');
  try {
    const result = fn();
    db.exec('COMMIT');
    return result;
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
}

function setting(key) {
  const row = one('SELECT value FROM settings WHERE key = ?', key);
  return row ? Number(row.value) : null;
}

function audit(actor, action, entity, entityId, details) {
  run('INSERT INTO audit (actor, action, entity, entity_id, details) VALUES (?, ?, ?, ?, ?)',
    actor, action, entity || null, entityId || null, details || null);
}

module.exports = { db, one, all, run, tx, setting, audit };
