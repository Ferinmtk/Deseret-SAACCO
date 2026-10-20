const express = require('express');
const { one, all, run, tx, setting, audit } = require('../db');
const { checkPassword, hashPassword, requireStaff } = require('../lib/auth');
const S = require('../lib/sacco');

const router = express.Router();

const ROLE_LABELS = { clerk: 'Clerk', credit: 'Credit Officer', manager: 'Manager', treasurer: 'Treasurer', board: 'Board / Supervisory' };
// Who may do what. Board members can see everything but change nothing.
const CAN = {
  registerMember: ['clerk', 'manager'],
  approveMember: ['manager'],
  handleRequests: ['clerk', 'manager'],
  recordPayment: ['clerk', 'manager'],
  approvePayment: ['manager', 'treasurer'],
  appraise: ['credit'],
  approveLoan: ['manager'],
  disburse: ['treasurer'],
  rejectLoan: ['credit', 'manager'],
  settings: ['manager'],
};

const logEvent = (loanId, step, actor, note) =>
  run('INSERT INTO loan_events (loan_id, step, actor, note, created_at) VALUES (?, ?, ?, ?, ?)', loanId, step, actor, note || null, S.now());

router.get('/login', (req, res) => {
  if (req.session.staffId) return res.redirect('/admin');
  res.render('admin/login', { error: null, email: '' });
});

router.post('/login', (req, res) => {
  const email = String(req.body.email || '').trim().toLowerCase();
  const staff = one('SELECT * FROM staff WHERE email = ?', email);
  if (!staff || !checkPassword(String(req.body.password || ''), staff.password_hash)) {
    return res.status(401).render('admin/login', { error: 'Email or password is incorrect.', email });
  }
  req.startSession({ staffId: staff.id, staffRole: staff.role });
  run('UPDATE staff SET last_login = ? WHERE id = ?', S.now(), staff.id);
  audit(staff.name, 'Staff signed in', 'staff', staff.id);
  res.redirect('/admin');
});

router.get('/logout', (req, res) => {
  req.endSession();
  res.redirect('/admin/login');
});

router.use(requireStaff());

router.use((req, res, next) => {
  req.staff = one('SELECT * FROM staff WHERE id = ?', req.session.staffId);
  if (!req.staff) { req.endSession(); return res.redirect('/admin/login'); }
  const role = req.staff.role;
  res.locals.staff = req.staff;
  res.locals.roleLabel = ROLE_LABELS[role];
  res.locals.can = Object.fromEntries(Object.entries(CAN).map(([k, roles]) => [k, roles.includes(role)]));
  res.locals.path = req.originalUrl;
  res.locals.counts = queueCounts(role);
  next();
});

const allow = action => (req, res, next) =>
  res.locals.can[action] ? next() : res.status(403).render('admin/denied', { title: 'Not allowed' });

function queueCounts(role) {
  const n = sql => one(sql).n;
  return {
    pendingMembers: n(`SELECT COUNT(*) AS n FROM members WHERE status = 'pending'`),
    pendingPayments: n(`SELECT COUNT(*) AS n FROM payments WHERE status = 'pending'`),
    memberCodes: n(`SELECT COUNT(*) AS n FROM payments WHERE status = 'pending' AND submitted_by_member = 1`),
    requests: n(`SELECT COUNT(*) AS n FROM requests WHERE status = 'pending'`),
    appraisal: n(`SELECT COUNT(*) AS n FROM loans WHERE status = 'appraisal'`),
    recommended: n(`SELECT COUNT(*) AS n FROM loans WHERE status = 'recommended'`),
    approved: n(`SELECT COUNT(*) AS n FROM loans WHERE status = 'approved'`),
    guarantors: n(`SELECT COUNT(*) AS n FROM loans WHERE status = 'guarantors'`),
    exiting: n(`SELECT COUNT(*) AS n FROM members WHERE status = 'exiting'`),
  };
}

function portfolio() {
  const loans = all(`SELECT l.*, m.first_name || ' ' || m.last_name AS name, m.member_no, m.phone, p.name AS product_name
                     FROM loans l JOIN members m ON m.id = l.member_id JOIN loan_products p ON p.code = l.product WHERE l.status = 'disbursed'`)
    .map(l => ({ ...l, state: S.loanState(l) }));
  const book = loans.reduce((s, l) => s + l.state.outstanding, 0);
  const atRisk = days => loans.filter(l => l.state.daysInArrears > days).reduce((s, l) => s + l.state.outstanding, 0);
  return { loans, book, par30: book ? atRisk(30) / book * 100 : 0, par90: book ? atRisk(90) / book * 100 : 0 };
}

router.get('/', (req, res) => {
  const totals = Object.fromEntries(all(`SELECT account, SUM(amount) AS total FROM transactions WHERE account != 'loan' GROUP BY account`).map(r => [r.account, r.total]));
  const members = one(`SELECT COUNT(*) AS n FROM members WHERE status IN ('active','exiting')`).n;
  const newMembers = one(`SELECT COUNT(*) AS n FROM members WHERE joined_at >= ?`, S.addMonths(S.today(), -12)).n;
  const pf = portfolio();
  const months = [];
  for (let i = 5; i >= 0; i--) {
    const start = S.addMonths(S.today(), -i).slice(0, 7);
    const row = one(`SELECT COALESCE(SUM(amount), 0) AS total FROM payments WHERE status = 'posted' AND substr(created_at, 1, 7) = ?`, start);
    months.push({ label: new Date(start + '-01').toLocaleDateString('en-GB', { month: 'short' }), total: row.total });
  }
  const channels = all(`SELECT channel, SUM(amount) AS total FROM payments WHERE status = 'posted' AND created_at >= ? GROUP BY channel`, S.addMonths(S.today(), -12));
  const exiting = all(`SELECT * FROM members WHERE status = 'exiting' ORDER BY exit_notice_at`).map(m => ({
    ...m, refundBy: S.fmtDate(new Date(new Date(m.exit_notice_at).getTime() + setting('exit_notice_days') * 86400000).toISOString()),
    daysLeft: setting('exit_notice_days') - S.daysBetween(m.exit_notice_at, S.today()),
  }));
  const staleGuarantees = all(`SELECT g.*, l.member_id, b.first_name || ' ' || b.last_name AS borrower, gm.first_name || ' ' || gm.last_name AS guarantor
                               FROM guarantees g JOIN loans l ON l.id = g.loan_id JOIN members b ON b.id = l.member_id JOIN members gm ON gm.id = g.guarantor_id
                               WHERE g.status = 'pending' AND l.status = 'guarantors' AND g.requested_at < datetime('now', '-3 days') ORDER BY g.requested_at`);
  const activity = all('SELECT * FROM audit ORDER BY id DESC LIMIT 8');
  res.render('admin/dashboard', { title: 'Dashboard', totals, members, newMembers, pf, months, channels, exiting, staleGuarantees, activity });
});

// ---------- Members ----------
router.get('/members', (req, res) => {
  const q = String(req.query.q || '').trim();
  const status = req.query.status || '';
  const like = `%${q}%`;
  const rows = all(`SELECT * FROM members WHERE (? = '' OR member_no LIKE ? OR first_name || ' ' || last_name LIKE ? OR id_number LIKE ? OR phone LIKE ? OR payroll_no LIKE ?)
                    AND (? = '' OR status = ?) ORDER BY status = 'pending' DESC, member_no LIMIT 200`, q, like, like, like, like, like, status, status)
    .map(m => ({ ...m, bal: S.balances(m.id) }));
  res.render('admin/members', { title: 'Members', rows, q, status });
});

router.get('/members/new', allow('registerMember'), (req, res) => res.render('admin/member-new', { title: 'Register member', error: null, form: {} }));

router.post('/members/new', allow('registerMember'), (req, res) => {
  const fields = ['first_name', 'last_name', 'id_number', 'kra_pin', 'phone', 'office_phone', 'email', 'date_of_birth', 'address', 'employer', 'department', 'designation',
    'terms', 'contract_end', 'payroll_no', 'ward', 'bank_name', 'bank_branch', 'bank_account', 'net_salary', 'nok_name', 'nok_relationship', 'nok_id', 'nok_phone', 'nok_address'];
  const f = Object.fromEntries(fields.map(k => [k, String(req.body[k] || '').trim()]));
  if (!['permanent', 'contract', 'not employed'].includes(f.terms)) f.terms = 'permanent';
  const error = !f.first_name || !f.last_name ? 'Enter the member’s full name.'
    : !/^\d{6,9}$/.test(f.id_number) ? 'ID number should be 6–9 digits.'
    : !/^0[17]\d{8}$/.test(f.phone.replace(/\s/g, '')) ? 'Enter a mobile number like 0712345678.'
    : one(`SELECT 1 AS x FROM members WHERE id_number = ? AND status != 'rejected'`, f.id_number) ? 'A member with this ID number already exists.'
    : f.terms === 'contract' && !f.contract_end ? 'Enter when the contract ends — loans must finish within it (By-law 64 XXV).'
    : !f.nok_name ? 'Enter the nominated next of kin.'
    : null;
  if (error) return res.status(400).render('admin/member-new', { title: 'Register member', error, form: f });
  const id = tx(() => {
    const id = run(`INSERT INTO members (first_name, last_name, id_number, kra_pin, phone, office_phone, email, date_of_birth, address, employer, department, designation,
                    terms, contract_end, payroll_no, ward, bank_name, bank_branch, bank_account, net_salary, status, created_by, created_at)
                    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?)`,
      f.first_name, f.last_name, f.id_number, f.kra_pin.toUpperCase(), f.phone.replace(/\s/g, ''), f.office_phone, f.email, f.date_of_birth || null, f.address,
      f.employer || null, f.department || null, f.designation || null, f.terms, f.contract_end || null, f.payroll_no, f.ward, f.bank_name, f.bank_branch, f.bank_account,
      parseInt(f.net_salary, 10) || 0, req.staff.id, S.now()).lastInsertRowid;
    run('INSERT INTO nominees (member_id, name, relationship, id_number, phone, address, share_pct) VALUES (?, ?, ?, ?, ?, ?, 100)',
      id, f.nok_name, f.nok_relationship, f.nok_id, f.nok_phone, f.nok_address);
    return id;
  });
  audit(req.staff.name, 'Registered member (pending approval)', 'member', id, `${f.first_name} ${f.last_name}`);
  req.flash('success', `${f.first_name} ${f.last_name} registered. A manager must approve before a member number is issued.`);
  res.redirect('/admin/members/' + id);
});

router.get('/members/:id', (req, res, next) => {
  const m = one('SELECT * FROM members WHERE id = ?', Number(req.params.id));
  if (!m) return next();
  const loans = S.memberLoans(m.id, ['guarantors', 'appraisal', 'recommended', 'approved', 'disbursed', 'closed', 'rejected']);
  const guarantees = all(`SELECT g.*, l.status AS loan_status, b.first_name || ' ' || b.last_name AS borrower, b.id AS borrower_id, p.name AS product_name
                          FROM guarantees g JOIN loans l ON l.id = g.loan_id JOIN members b ON b.id = l.member_id JOIN loan_products p ON p.code = l.product
                          WHERE g.guarantor_id = ? ORDER BY g.requested_at DESC`, m.id);
  const payments = all('SELECT * FROM payments WHERE member_id = ? ORDER BY created_at DESC LIMIT 24', m.id);
  const nominees = all('SELECT * FROM nominees WHERE member_id = ?', m.id);
  const history = all(`SELECT * FROM audit WHERE entity = 'member' AND entity_id = ? ORDER BY id DESC LIMIT 20`, m.id);
  const maker = m.created_by ? one('SELECT name FROM staff WHERE id = ?', m.created_by) : null;
  res.render('admin/member', {
    title: `${m.first_name} ${m.last_name}`, m, bal: S.balances(m.id), loans, guarantees, payments, nominees, history, maker,
    capacity: S.guarantorCapacity(m.id), tab: req.query.tab || 'accounts',
  });
});

router.post('/members/:id/decision', allow('approveMember'), (req, res) => {
  const m = one(`SELECT * FROM members WHERE id = ? AND status = 'pending'`, Number(req.params.id));
  if (!m) return res.redirect('/admin/members');
  if (m.created_by === req.staff.id) {
    req.flash('danger', 'You registered this member, so someone else must approve it.');
    return res.redirect('/admin/members/' + m.id);
  }
  if (req.body.decision === 'approve') {
    const next = one(`SELECT COALESCE(MAX(CAST(substr(member_no, 3) AS INTEGER)), 0) + 1 AS n FROM members WHERE member_no IS NOT NULL`).n;
    const memberNo = 'DS' + String(next).padStart(4, '0');
    const minute = String(req.body.minute || '').trim();
    if (!minute) {
      req.flash('danger', 'Enter the management committee minute number that admitted this member.');
      return res.redirect('/admin/members/' + m.id);
    }
    run(`UPDATE members SET status = 'active', member_no = ?, joined_at = ?, approved_by = ?, admission_minute = ?, password_hash = ? WHERE id = ?`,
      memberNo, S.today(), req.staff.id, minute, hashPassword(m.id_number), m.id);
    audit(req.staff.name, 'Approved member', 'member', m.id, `${memberNo} (minute ${minute})`);
    req.flash('success', `Approved as ${memberNo}. Their first portal password is their ID number.`);
  } else {
    run(`UPDATE members SET status = 'rejected', approved_by = ? WHERE id = ?`, req.staff.id, m.id);
    audit(req.staff.name, 'Rejected member application', 'member', m.id, String(req.body.reason || ''));
    req.flash('success', 'Application rejected.');
  }
  res.redirect('/admin/members/' + m.id);
});

// ---------- Payments ----------
router.get('/payments', (req, res) => {
  const status = req.query.status || '';
  const rows = all(`SELECT p.*, m.first_name || ' ' || m.last_name AS name, m.member_no, COALESCE(s.name, CASE WHEN p.submitted_by_member THEN 'Member (code)' END) AS maker, a.name AS checker
                    FROM payments p JOIN members m ON m.id = p.member_id LEFT JOIN staff s ON s.id = p.created_by LEFT JOIN staff a ON a.id = p.approved_by
                    WHERE (? = '' OR p.status = ?) ORDER BY p.status = 'pending' DESC, p.created_at DESC LIMIT 150`, status, status);
  for (const p of rows) p.split = p.status === 'pending' ? JSON.parse(p.note || '[]') : null;
  res.render('admin/payments', { title: 'Payments', rows, status });
});

router.get('/payments/new', allow('recordPayment'), (req, res) => {
  const member = req.query.member ? one(`SELECT * FROM members WHERE member_no = ? AND status IN ('active','exiting')`, String(req.query.member).toUpperCase()) : null;
  const loans = member ? S.memberLoans(member.id, ['disbursed']) : [];
  res.render('admin/payment-new', { title: 'Record payment', member, loans, error: null, query: req.query.member || '' });
});

router.post('/payments/new', allow('recordPayment'), (req, res) => {
  const member = one(`SELECT * FROM members WHERE member_no = ? AND status IN ('active','exiting')`, String(req.body.member_no || '').toUpperCase());
  if (!member) { req.flash('danger', 'Member not found.'); return res.redirect('/admin/payments/new'); }
  const loans = S.memberLoans(member.id, ['disbursed']);
  const split = [];
  for (const key of [...Object.keys(S.ACCOUNTS), ...loans.map(l => 'loan:' + l.id)]) {
    const amount = parseInt(req.body['alloc_' + key.replace(':', '_')], 10) || 0;
    if (amount > 0) split.push(key.startsWith('loan:') ? { account: 'loan', loan_id: Number(key.slice(5)), amount } : { account: key, amount });
  }
  const amount = parseInt(req.body.amount, 10) || 0;
  const total = split.reduce((s, p) => s + p.amount, 0);
  const reference = String(req.body.reference || '').trim();
  const error = !S.CHANNELS[req.body.channel] ? 'Choose how the money came in.'
    : !reference ? 'Enter the bank slip, M-Pesa code or check-off reference.'
    : amount <= 0 ? 'Enter the amount received.'
    : total !== amount ? `The split adds up to ${S.fmtKes(total)}, but the payment is ${S.fmtKes(amount)}.`
    : one('SELECT 1 AS x FROM payments WHERE reference = ? AND channel = ?', reference, req.body.channel) ? 'This reference has already been recorded.'
    : null;
  if (error) return res.status(400).render('admin/payment-new', { title: 'Record payment', member, loans, error, query: member.member_no });
  const id = run(`INSERT INTO payments (member_id, amount, channel, reference, status, created_by, note, created_at) VALUES (?, ?, ?, ?, 'pending', ?, ?, ?)`,
    member.id, amount, req.body.channel, reference, req.staff.id, JSON.stringify(split), S.now()).lastInsertRowid;
  audit(req.staff.name, 'Recorded payment (pending approval)', 'payment', id, `${member.member_no} ${S.fmtKes(amount)} ${reference}`);
  req.flash('success', `Payment recorded for ${member.first_name} ${member.last_name}. It posts once a manager or treasurer approves it.`);
  res.redirect('/admin/payments?status=pending');
});

router.post('/payments/:id/decision', (req, res) => {
  const p = one(`SELECT * FROM payments WHERE id = ? AND status = 'pending'`, Number(req.params.id));
  if (!p) return res.redirect('/admin/payments');
  // Staff-entered payments need a manager or treasurer; codes members submit themselves can also be checked by a clerk.
  const mayApprove = res.locals.can.approvePayment || (p.submitted_by_member && req.staff.role === 'clerk');
  if (!mayApprove) return res.status(403).render('admin/denied', { title: 'Not allowed' });
  if (p.created_by === req.staff.id) {
    req.flash('danger', 'You recorded this payment, so someone else must approve it.');
    return res.redirect('/admin/payments?status=pending');
  }
  if (req.body.decision === 'approve') {
    tx(() => {
      run(`UPDATE payments SET status = 'posted', approved_by = ? WHERE id = ?`, req.staff.id, p.id);
      for (const part of JSON.parse(p.note || '[]')) {
        const desc = part.account === 'loan' ? 'Loan repayment' : `${S.CHANNELS[p.channel]} — ${S.ACCOUNTS[part.account]}`;
        run(`INSERT INTO transactions (member_id, payment_id, loan_id, account, amount, description, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)`,
          p.member_id, p.id, part.loan_id || null, part.account, part.amount, desc, p.created_at);
        if (part.loan_id) {
          const loan = one('SELECT * FROM loans WHERE id = ?', part.loan_id);
          if (S.loanState(loan).outstanding === 0) { run(`UPDATE loans SET status = 'closed' WHERE id = ?`, loan.id); logEvent(loan.id, 'closed', 'System', 'Loan fully repaid'); }
        }
      }
    });
    audit(req.staff.name, 'Approved payment', 'payment', p.id, `${S.fmtKes(p.amount)} ${p.reference}`);
    req.flash('success', `Payment ${p.reference} posted.`);
  } else {
    run(`UPDATE payments SET status = 'rejected', approved_by = ? WHERE id = ?`, req.staff.id, p.id);
    audit(req.staff.name, 'Rejected payment', 'payment', p.id, `${p.reference} — ${req.body.reason || 'no reason'}`);
    req.flash('success', `Payment ${p.reference} rejected.`);
  }
  res.redirect('/admin/payments?status=pending');
});

// ---------- Loans ----------
router.get('/loans', (req, res) => {
  const rows = all(`SELECT l.*, m.first_name || ' ' || m.last_name AS name, m.member_no, p.name AS product_name,
                    (SELECT COUNT(*) FROM guarantees g WHERE g.loan_id = l.id AND g.status = 'accepted') AS accepted,
                    (SELECT COUNT(*) FROM guarantees g WHERE g.loan_id = l.id) AS requested
                    FROM loans l JOIN members m ON m.id = l.member_id JOIN loan_products p ON p.code = l.product
                    WHERE l.status IN ('guarantors','appraisal','recommended','approved') ORDER BY l.applied_at`);
  const columns = ['guarantors', 'appraisal', 'recommended', 'approved'].map(s => ({ status: s, label: S.STATUS_LABELS[s], rows: rows.filter(r => r.status === s) }));
  const pf = portfolio();
  const recent = all(`SELECT l.*, m.first_name || ' ' || m.last_name AS name, p.name AS product_name FROM loans l JOIN members m ON m.id = l.member_id
                      JOIN loan_products p ON p.code = l.product WHERE l.status IN ('disbursed','closed','rejected') ORDER BY l.applied_at DESC LIMIT 15`)
    .map(l => ({ ...l, state: S.loanState(l) }));
  res.render('admin/loans', { title: 'Loans', columns, pf, recent });
});

router.get('/loans/:id', (req, res, next) => {
  const loan = one(`SELECT l.*, p.name AS product_name FROM loans l JOIN loan_products p ON p.code = l.product WHERE l.id = ?`, Number(req.params.id));
  if (!loan) return next();
  loan.state = S.loanState(loan);
  const appraisal = S.appraise(loan);
  const events = all('SELECT * FROM loan_events WHERE loan_id = ? ORDER BY created_at, id', loan.id);
  const people = Object.fromEntries(all('SELECT id, name FROM staff').map(s => [s.id, s.name]));
  for (const g of appraisal.guarantees) g.capacity = S.guarantorCapacity(g.guarantor_id);
  res.render('admin/loan', { title: `Loan #${loan.id}`, loan, appraisal, events, people });
});

function loanAction(action, from, to, check) {
  return (req, res) => {
    const loan = one('SELECT * FROM loans WHERE id = ?', Number(req.params.id));
    if (!loan || loan.status !== from) return res.redirect('/admin/loans');
    const problem = check && check(loan, req);
    if (problem) { req.flash('danger', problem); return res.redirect('/admin/loans/' + loan.id); }
    const note = String(req.body.note || '').trim();
    tx(() => {
      const col = { recommend: 'recommended_by', approve: 'approved_by', disburse: 'disbursed_by' }[action];
      run(`UPDATE loans SET status = ?, ${col} = ?${action === 'disburse' ? ', disbursed_at = ?' : ''} WHERE id = ?`,
        ...(action === 'disburse' ? [to, req.staff.id, S.today(), loan.id] : [to, req.staff.id, loan.id]));
      logEvent(loan.id, to, req.staff.name, note || { recommend: 'Recommended for approval', approve: 'Approved by credit committee', disburse: `Disbursed ${S.fmtKes(loan.principal - loan.fee)} (after ${S.fmtKes(loan.fee)} fee)` }[action]);
    });
    audit(req.staff.name, `Loan ${action}`, 'loan', loan.id, note);
    req.flash('success', { recommend: 'Recommended — sent to the manager.', approve: 'Approved — sent to the treasurer for disbursement.', disburse: 'Disbursed. The repayment schedule starts next month.' }[action]);
    res.redirect('/admin/loans/' + loan.id);
  };
}

router.post('/loans/:id/recommend', allow('appraise'), loanAction('recommend', 'appraisal', 'recommended',
  loan => S.appraise(loan).passed ? null : 'Some appraisal checks fail. Resolve them or decline the loan.'));
router.post('/loans/:id/approve', allow('approveLoan'), loanAction('approve', 'recommended', 'approved',
  (loan, req) => loan.recommended_by === req.staff.id ? 'The person who recommended a loan can’t also approve it.' : null));
router.post('/loans/:id/disburse', allow('disburse'), loanAction('disburse', 'approved', 'disbursed',
  (loan, req) => loan.approved_by === req.staff.id ? 'The person who approved a loan can’t also disburse it.' : null));

router.post('/loans/:id/reject', allow('rejectLoan'), (req, res) => {
  const loan = one(`SELECT * FROM loans WHERE id = ? AND status IN ('guarantors','appraisal','recommended')`, Number(req.params.id));
  const reason = String(req.body.reason || '').trim();
  if (!loan) return res.redirect('/admin/loans');
  if (!reason) { req.flash('danger', 'Give the member a reason for declining.'); return res.redirect('/admin/loans/' + loan.id); }
  tx(() => {
    run(`UPDATE loans SET status = 'rejected', reject_reason = ? WHERE id = ?`, reason, loan.id);
    logEvent(loan.id, 'rejected', req.staff.name, reason);
  });
  audit(req.staff.name, 'Loan declined', 'loan', loan.id, reason);
  req.flash('success', 'Loan declined. Guarantors have been released.');
  res.redirect('/admin/loans/' + loan.id);
});

router.get('/arrears', (req, res) => {
  const pf = portfolio();
  const rows = pf.loans.filter(l => l.state.arrears > 0).sort((a, b) => b.state.daysInArrears - a.state.daysInArrears);
  const defaultAfter = setting('default_after_months');
  for (const l of rows) {
    l.bucket = S.bucket(l.state.daysInArrears);
    // By-law 64(XXVI): month 1 letter to borrower (copy guarantors), month 2 warn guarantors, month 3 default.
    l.missed = Math.ceil(l.state.arrears / l.installment);
    l.stage = l.missed >= defaultAfter ? 'Declared in default — recover from guarantors'
      : l.missed === 2 ? 'Warn guarantors' : 'Letter to borrower, copy guarantors';
    l.shares = S.balances(l.member_id).deposits;
    l.lastPaid = one(`SELECT MAX(created_at) AS d FROM transactions WHERE loan_id = ? AND account = 'loan'`, l.id).d;
    l.guarantors = all(`SELECT g.amount, m.first_name || ' ' || m.last_name AS name, m.phone FROM guarantees g JOIN members m ON m.id = g.guarantor_id
                        WHERE g.loan_id = ? AND g.status = 'accepted'`, l.id);
  }
  const buckets = ['1–30 days', '31–60 days', '61–90 days', '90+ days'].map(b => ({
    label: b, count: rows.filter(r => r.bucket === b).length, amount: rows.filter(r => r.bucket === b).reduce((s, r) => s + r.state.outstanding, 0),
  }));
  res.render('admin/arrears', { title: 'Arrears', rows, buckets, pf });
});

// ---------- Approvals inbox ----------
router.get('/approvals', (req, res) => {
  const members = all(`SELECT m.*, s.name AS maker FROM members m LEFT JOIN staff s ON s.id = m.created_by WHERE m.status = 'pending' ORDER BY m.created_at`);
  const payments = all(`SELECT p.*, m.first_name || ' ' || m.last_name AS name, m.member_no, COALESCE(s.name, 'the member') AS maker FROM payments p
                        JOIN members m ON m.id = p.member_id LEFT JOIN staff s ON s.id = p.created_by WHERE p.status = 'pending' ORDER BY p.created_at`);
  for (const p of payments) p.split = JSON.parse(p.note || '[]');
  const loans = all(`SELECT l.*, m.first_name || ' ' || m.last_name AS name, p.name AS product_name FROM loans l JOIN members m ON m.id = l.member_id
                     JOIN loan_products p ON p.code = l.product WHERE l.status IN ('appraisal','recommended','approved') ORDER BY l.applied_at`);
  const requests = all(`SELECT r.*, m.first_name || ' ' || m.last_name AS name, m.member_no, m.payroll_no FROM requests r JOIN members m ON m.id = r.member_id
                         WHERE r.status = 'pending' ORDER BY r.created_at`).map(r => ({ ...r, d: JSON.parse(r.details) }));
  res.render('admin/approvals', { title: 'My work', members, payments, loans, requests });
});

router.post('/requests/:id', allow('handleRequests'), (req, res) => {
  const r = one(`SELECT * FROM requests WHERE id = ? AND status = 'pending'`, Number(req.params.id));
  if (!r) return res.redirect('/admin/approvals');
  const approved = req.body.decision === 'approve';
  run('UPDATE requests SET status = ?, handled_by = ? WHERE id = ?', approved ? 'approved' : 'rejected', req.staff.id, r.id);
  audit(req.staff.name, approved ? 'Deduction change actioned' : 'Deduction change rejected', 'member', r.member_id, r.details);
  req.flash('success', approved ? 'Marked as done. Remember to update the payroll check-off schedule.' : 'Request rejected.');
  res.redirect('/admin/approvals');
});

// ---------- Settings & audit ----------
router.get('/settings', (req, res) => {
  res.render('admin/settings', {
    title: 'Products & rules',
    settings: all('SELECT * FROM settings ORDER BY rowid'),
    products: all('SELECT * FROM loan_products ORDER BY rowid'),
    staffList: all('SELECT * FROM staff ORDER BY id'),
    ROLE_LABELS,
  });
});

router.post('/settings', allow('settings'), (req, res) => {
  const changes = [];
  tx(() => {
    for (const s of all('SELECT * FROM settings')) {
      const v = req.body['s_' + s.key];
      if (v !== undefined && v !== '' && !isNaN(Number(v)) && Number(v) !== Number(s.value)) {
        run('UPDATE settings SET value = ? WHERE key = ?', String(Number(v)), s.key);
        changes.push(`${s.label}: ${s.value} → ${Number(v)}`);
      }
    }
    for (const p of all('SELECT * FROM loan_products')) {
      const field = k => req.body[`p_${p.code}_${k}`];
      const rate = Number(field('rate')) / 100, months = parseInt(field('months'), 10), mult = Number(field('multiplier'));
      const guar = parseInt(field('guarantors'), 10), fee = Number(field('fee'));
      if ([rate, months, mult, guar, fee].some(n => isNaN(n))) continue;
      if (rate !== p.rate_monthly || months !== p.max_months || mult !== p.multiplier || guar !== p.min_guarantors || fee !== p.fee_pct) {
        run('UPDATE loan_products SET rate_monthly = ?, max_months = ?, multiplier = ?, min_guarantors = ?, fee_pct = ? WHERE code = ?', rate, months, mult, guar, fee, p.code);
        changes.push(`${p.name}: ${(p.rate_monthly * 100).toFixed(2)}%/${p.max_months}m/${p.multiplier}×/${p.min_guarantors}g/${p.fee_pct}% → ${(rate * 100).toFixed(2)}%/${months}m/${mult}×/${guar}g/${fee}%`);
      }
    }
  });
  if (changes.length) audit(req.staff.name, 'Changed rules', 'settings', null, changes.join('; '));
  req.flash('success', changes.length ? `Saved ${changes.length} change(s). Existing loans keep their original terms.` : 'Nothing changed.');
  res.redirect('/admin/settings');
});

router.get('/audit', (req, res) => {
  const q = String(req.query.q || '').trim();
  const rows = all(`SELECT * FROM audit WHERE (? = '' OR actor LIKE ? OR action LIKE ? OR details LIKE ?) ORDER BY id DESC LIMIT 300`, q, `%${q}%`, `%${q}%`, `%${q}%`);
  res.render('admin/audit', { title: 'Audit trail', rows, q });
});

module.exports = router;
