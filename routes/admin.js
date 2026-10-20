const crypto = require('crypto');
const express = require('express');
const { one, all, run, tx, setting, audit } = require('../db');
const { checkPassword, hashPassword, requireStaff } = require('../lib/auth');
const S = require('../lib/sacco');
const { lockedFor, recordFailure, clearFailures } = require('../lib/security');
const { sendCsv } = require('../lib/csv');

const router = express.Router();

const ROLE_LABELS = { clerk: 'Clerk', credit: 'Credit Officer', manager: 'Manager', treasurer: 'Treasurer', board: 'Board / Supervisory' };
// Who may do what. Board members can see everything but change nothing.
const CAN = {
  registerMember: ['clerk', 'manager'],
  approveMember: ['manager'],
  handleRequests: ['clerk', 'manager'],
  answerMessages: ['clerk', 'manager'],
  recordPayment: ['clerk', 'manager'],
  approvePayment: ['manager', 'treasurer'],
  appraise: ['credit'],
  approveLoan: ['manager'],
  disburse: ['treasurer'],
  rejectLoan: ['credit', 'manager'],
  settings: ['manager'],
  // Downloads contain members' personal and money details, so only oversight roles get them.
  export: ['manager', 'treasurer', 'board'],
};

const logEvent = (loanId, step, actor, note) =>
  run('INSERT INTO loan_events (loan_id, step, actor, note, created_at) VALUES (?, ?, ?, ?, ?)', loanId, step, actor, note || null, S.now());
const idParam = req => Number(req.params.id) || 0;

router.get('/login', (req, res) => {
  if (req.session.staffId) return res.redirect('/admin');
  res.render('admin/login', { error: null, email: '' });
});

router.post('/login', async (req, res) => {
  const email = String(req.body.email || '').trim().toLowerCase().slice(0, 200);
  const locked = await lockedFor('staff', email, req);
  if (locked) return res.status(429).render('admin/login', { error: `Too many wrong passwords. Try again in ${locked} minute${locked === 1 ? '' : 's'}.`, email });
  const staff = await one('SELECT * FROM staff WHERE email = ?', email);
  // A switched-off login (someone who has left office) fails like a wrong password.
  if (!staff || !staff.active || !checkPassword(String(req.body.password || ''), staff.password_hash)) {
    await recordFailure('staff', email, req);
    await audit(email, 'Failed staff sign-in', 'staff', staff ? staff.id : null, req.ip);
    return res.status(401).render('admin/login', { error: 'Email or password is incorrect.', email });
  }
  await clearFailures('staff', email);
  await req.startSession({ staffId: staff.id, staffRole: staff.role });
  await run('UPDATE staff SET last_login = ? WHERE id = ?', S.now(), staff.id);
  await audit(staff.name, 'Staff signed in', 'staff', staff.id);
  res.redirect('/admin');
});

router.get('/logout', async (req, res) => {
  await req.endSession();
  res.redirect('/admin/login');
});

router.use(requireStaff());

router.use(async (req, res, next) => {
  req.staff = await one('SELECT * FROM staff WHERE id = ?', req.session.staffId);
  if (!req.staff || !req.staff.active) { await req.endSession(); return res.redirect('/admin/login'); }
  if (req.staff.must_change_password && !['/change-password', '/logout'].includes(req.path)) return res.redirect('/admin/change-password');
  const role = req.staff.role;
  res.locals.staff = req.staff;
  res.locals.roleLabel = ROLE_LABELS[role];
  res.locals.can = Object.fromEntries(Object.entries(CAN).map(([k, roles]) => [k, roles.includes(role)]));
  res.locals.path = req.originalUrl;
  res.locals.counts = await queueCounts();
  next();
});

const allow = action => (req, res, next) =>
  res.locals.can[action] ? next() : res.status(403).render('admin/denied', { title: 'Not allowed' });

async function queueCounts() {
  return one(`SELECT
    (SELECT COUNT(*) FROM members WHERE status = 'pending') AS "pendingMembers",
    (SELECT COUNT(*) FROM payments WHERE status = 'pending') AS "pendingPayments",
    (SELECT COUNT(*) FROM payments WHERE status = 'pending' AND submitted_by_member) AS "memberCodes",
    (SELECT COUNT(*) FROM requests WHERE status = 'pending') AS requests,
    (SELECT COUNT(*) FROM loans WHERE status = 'appraisal') AS appraisal,
    (SELECT COUNT(*) FROM loans WHERE status = 'recommended') AS recommended,
    (SELECT COUNT(*) FROM loans WHERE status = 'approved') AS approved,
    (SELECT COUNT(*) FROM loans WHERE status = 'guarantors') AS guarantors,
    (SELECT COUNT(*) FROM members WHERE status = 'exiting') AS exiting,
    (SELECT COUNT(*) FROM contact_messages WHERE status = 'new') AS messages`);
}

async function portfolio() {
  const loans = await S.withState(await all(`SELECT l.*, m.first_name || ' ' || m.last_name AS name, m.member_no, m.phone, p.name AS product_name
                     FROM loans l JOIN members m ON m.id = l.member_id JOIN loan_products p ON p.code = l.product WHERE l.status = 'disbursed'`));
  const book = loans.reduce((s, l) => s + l.state.outstanding, 0);
  const atRisk = days => loans.filter(l => l.state.daysInArrears > days).reduce((s, l) => s + l.state.outstanding, 0);
  return { loans, book, par30: book ? atRisk(30) / book * 100 : 0, par90: book ? atRisk(90) / book * 100 : 0 };
}

const refundBy = m => S.fmtDate(new Date(new Date(m.exit_notice_at).getTime() + setting('exit_notice_days') * 86400000).toISOString());

router.get('/', async (req, res) => {
  const totals = Object.fromEntries((await all(`SELECT account, SUM(amount) AS total FROM transactions WHERE account != 'loan' GROUP BY account`)).map(r => [r.account, r.total]));
  const members = (await one(`SELECT COUNT(*) AS n FROM members WHERE status IN ('active','exiting')`)).n;
  const newMembers = (await one(`SELECT COUNT(*) AS n FROM members WHERE joined_at >= ?`, S.addMonths(S.today(), -12))).n;
  const pf = await portfolio();
  const byMonth = Object.fromEntries((await all(`SELECT to_char(created_at, 'YYYY-MM') AS month, SUM(amount) AS total FROM payments
                                                 WHERE status = 'posted' AND created_at >= ? GROUP BY 1`, S.addMonths(S.today(), -5).slice(0, 8) + '01')).map(r => [r.month, r.total]));
  const months = [];
  for (let i = 5; i >= 0; i--) {
    const start = S.addMonths(S.today(), -i).slice(0, 7);
    months.push({ label: new Date(start + '-01').toLocaleDateString('en-GB', { month: 'short' }), total: byMonth[start] || 0 });
  }
  const channels = await all(`SELECT channel, SUM(amount) AS total FROM payments WHERE status = 'posted' AND created_at >= ? GROUP BY channel`, S.addMonths(S.today(), -12));
  const exiting = (await all(`SELECT * FROM members WHERE status = 'exiting' ORDER BY exit_notice_at`)).map(m => ({
    ...m, refundBy: refundBy(m), daysLeft: setting('exit_notice_days') - S.daysBetween(m.exit_notice_at, S.today()),
  }));
  const staleGuarantees = await all(`SELECT g.*, l.member_id, b.first_name || ' ' || b.last_name AS borrower, gm.first_name || ' ' || gm.last_name AS guarantor
                               FROM guarantees g JOIN loans l ON l.id = g.loan_id JOIN members b ON b.id = l.member_id JOIN members gm ON gm.id = g.guarantor_id
                               WHERE g.status = 'pending' AND l.status = 'guarantors' AND g.requested_at < now() - interval '3 days' ORDER BY g.requested_at`);
  const activity = await all(`SELECT * FROM audit WHERE action NOT IN ('Staff signed in', 'Member signed in') ORDER BY id DESC LIMIT 8`);
  res.render('admin/dashboard', { title: 'Dashboard', REPORTS, today: S.today(), yearAgo: S.addMonths(S.today(), -12), totals, members, newMembers, pf, months, channels, exiting, staleGuarantees, activity });
});

// ---------- Members ----------
router.get('/members', async (req, res) => {
  const q = String(req.query.q || '').trim();
  const status = String(req.query.status || '');
  const like = `%${q}%`;
  const rows = await all(`SELECT * FROM members WHERE (?::text = '' OR member_no ILIKE ? OR first_name || ' ' || last_name ILIKE ? OR id_number ILIKE ? OR phone ILIKE ? OR payroll_no ILIKE ?)
                          AND (?::text = '' OR status = ?) ORDER BY status = 'pending' DESC, member_no LIMIT 200`, q, like, like, like, like, like, status, status);
  const bal = await S.balancesFor(rows.map(m => m.id));
  for (const m of rows) m.bal = bal[m.id];
  res.render('admin/members', { title: 'Members', rows, q, status });
});

router.get('/members/new', allow('registerMember'), (req, res) => res.render('admin/member-new', { title: 'Register member', error: null, form: {} }));

router.post('/members/new', allow('registerMember'), async (req, res) => {
  const fields = ['first_name', 'last_name', 'id_number', 'kra_pin', 'phone', 'office_phone', 'email', 'date_of_birth', 'address', 'employer', 'department', 'designation',
    'terms', 'contract_end', 'payroll_no', 'ward', 'bank_name', 'bank_branch', 'bank_account', 'net_salary', 'nok_name', 'nok_relationship', 'nok_id', 'nok_phone', 'nok_address'];
  const f = Object.fromEntries(fields.map(k => [k, String(req.body[k] || '').trim()]));
  if (!['permanent', 'contract', 'not employed'].includes(f.terms)) f.terms = 'permanent';
  const error = !f.first_name || !f.last_name ? 'Enter the member’s full name.'
    : !/^\d{6,9}$/.test(f.id_number) ? 'ID number should be 6 to 9 digits.'
    : !/^0[17]\d{8}$/.test(f.phone.replace(/\s/g, '')) ? 'Enter a mobile number like 0712345678.'
    : await one(`SELECT 1 AS x FROM members WHERE id_number = ? AND status != 'rejected'`, f.id_number) ? 'A member with this ID number already exists.'
    : f.terms === 'contract' && !f.contract_end ? 'Enter when the contract ends. Loans must finish within it (By-law 64 XXV).'
    : !f.nok_name ? 'Enter the nominated next of kin.'
    : null;
  if (error) return res.status(400).render('admin/member-new', { title: 'Register member', error, form: f });
  const id = await tx(async () => {
    const id = (await run(`INSERT INTO members (first_name, last_name, id_number, kra_pin, phone, office_phone, email, date_of_birth, address, employer, department, designation,
                           terms, contract_end, payroll_no, ward, bank_name, bank_branch, bank_account, net_salary, status, created_by, created_at)
                           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?)`,
      f.first_name, f.last_name, f.id_number, f.kra_pin.toUpperCase(), f.phone.replace(/\s/g, ''), f.office_phone, f.email, f.date_of_birth || null, f.address,
      f.employer || null, f.department || null, f.designation || null, f.terms, f.contract_end || null, f.payroll_no, f.ward, f.bank_name, f.bank_branch, f.bank_account,
      parseInt(f.net_salary, 10) || 0, req.staff.id, S.now())).lastInsertRowid;
    await run('INSERT INTO nominees (member_id, name, relationship, id_number, phone, address, share_pct) VALUES (?, ?, ?, ?, ?, ?, 100)',
      id, f.nok_name, f.nok_relationship, f.nok_id, f.nok_phone, f.nok_address);
    return id;
  });
  await audit(req.staff.name, 'Registered member (pending approval)', 'member', id, `${f.first_name} ${f.last_name}`);
  req.flash('success', `${f.first_name} ${f.last_name} registered. A manager must approve before a member number is issued.`);
  res.redirect('/admin/members/' + id);
});

router.get('/members/:id', async (req, res, next) => {
  const m = await one('SELECT * FROM members WHERE id = ?', idParam(req));
  if (!m) return next();
  const loans = await S.memberLoans(m.id, ['guarantors', 'appraisal', 'recommended', 'approved', 'disbursed', 'closed', 'rejected']);
  const guarantees = await all(`SELECT g.*, l.status AS loan_status, b.first_name || ' ' || b.last_name AS borrower, b.id AS borrower_id, p.name AS product_name
                                FROM guarantees g JOIN loans l ON l.id = g.loan_id JOIN members b ON b.id = l.member_id JOIN loan_products p ON p.code = l.product
                                WHERE g.guarantor_id = ? ORDER BY g.requested_at DESC`, m.id);
  const payments = await all('SELECT * FROM payments WHERE member_id = ? ORDER BY created_at DESC LIMIT 24', m.id);
  const nominees = await all('SELECT * FROM nominees WHERE member_id = ?', m.id);
  const history = await all(`SELECT * FROM audit WHERE entity = 'member' AND entity_id = ? ORDER BY id DESC LIMIT 20`, m.id);
  const maker = m.created_by ? await one('SELECT name FROM staff WHERE id = ?', m.created_by) : null;
  res.render('admin/member', {
    title: `${m.first_name} ${m.last_name}`, m, bal: await S.balances(m.id), loans, guarantees, payments, nominees, history, maker,
    capacity: await S.guarantorCapacity(m.id), tab: req.query.tab || 'accounts',
  });
});

router.post('/members/:id/decision', allow('approveMember'), async (req, res) => {
  const m = await one(`SELECT * FROM members WHERE id = ? AND status = 'pending'`, idParam(req));
  if (!m) return res.redirect('/admin/members');
  if (m.created_by === req.staff.id) {
    req.flash('danger', 'You registered this member, so someone else must approve it.');
    return res.redirect('/admin/members/' + m.id);
  }
  if (req.body.decision === 'approve') {
    const minute = String(req.body.minute || '').trim();
    if (!minute) {
      req.flash('danger', 'Enter the management committee minute number that admitted this member.');
      return res.redirect('/admin/members/' + m.id);
    }
    const memberNo = await tx(async () => {
      const next = (await one(`SELECT COALESCE(MAX(CAST(substr(member_no, 3) AS INTEGER)), 0) + 1 AS n FROM members WHERE member_no IS NOT NULL`)).n;
      const no = 'DS' + String(next).padStart(4, '0');
      await run(`UPDATE members SET status = 'active', member_no = ?, joined_at = ?, approved_by = ?, admission_minute = ?, password_hash = ?, must_change_password = true WHERE id = ?`,
        no, S.today(), req.staff.id, minute, hashPassword(m.id_number), m.id);
      return no;
    });
    await audit(req.staff.name, 'Approved member', 'member', m.id, `${memberNo} (minute ${minute})`);
    req.flash('success', `Approved as ${memberNo}. They sign in first with their ID number and must then choose a new password.`);
  } else {
    await run(`UPDATE members SET status = 'rejected', approved_by = ? WHERE id = ?`, req.staff.id, m.id);
    await audit(req.staff.name, 'Rejected member application', 'member', m.id, String(req.body.reason || ''));
    req.flash('success', 'Application rejected.');
  }
  res.redirect('/admin/members/' + m.id);
});

// ---------- Payments ----------
router.get('/payments', async (req, res) => {
  const status = String(req.query.status || '');
  const rows = await all(`SELECT p.*, m.first_name || ' ' || m.last_name AS name, m.member_no, COALESCE(s.name, CASE WHEN p.submitted_by_member THEN 'Member (code)' END) AS maker, a.name AS checker
                          FROM payments p JOIN members m ON m.id = p.member_id LEFT JOIN staff s ON s.id = p.created_by LEFT JOIN staff a ON a.id = p.approved_by
                          WHERE (?::text = '' OR p.status = ?) ORDER BY p.status = 'pending' DESC, p.created_at DESC LIMIT 150`, status, status);
  for (const p of rows) p.split = p.status === 'pending' ? JSON.parse(p.note || '[]') : null;
  res.render('admin/payments', { title: 'Payments', rows, status });
});

router.get('/payments/new', allow('recordPayment'), async (req, res) => {
  const member = req.query.member ? await one(`SELECT * FROM members WHERE member_no = ? AND status IN ('active','exiting')`, String(req.query.member).toUpperCase()) : null;
  const loans = member ? await S.memberLoans(member.id, ['disbursed']) : [];
  res.render('admin/payment-new', { title: 'Record payment', member, loans, error: null, query: req.query.member || '' });
});

router.post('/payments/new', allow('recordPayment'), async (req, res) => {
  const member = await one(`SELECT * FROM members WHERE member_no = ? AND status IN ('active','exiting')`, String(req.body.member_no || '').toUpperCase());
  if (!member) { req.flash('danger', 'Member not found.'); return res.redirect('/admin/payments/new'); }
  const loans = await S.memberLoans(member.id, ['disbursed']);
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
    : total !== amount ? `The split adds up to ${S.fmtKes(total)} but the payment is ${S.fmtKes(amount)}.`
    : await one('SELECT 1 AS x FROM payments WHERE reference = ? AND channel = ?', reference, req.body.channel) ? 'This reference has already been recorded.'
    : null;
  if (error) return res.status(400).render('admin/payment-new', { title: 'Record payment', member, loans, error, query: member.member_no });
  const id = (await run(`INSERT INTO payments (member_id, amount, channel, reference, status, created_by, note, created_at) VALUES (?, ?, ?, ?, 'pending', ?, ?, ?)`,
    member.id, amount, req.body.channel, reference, req.staff.id, JSON.stringify(split), S.now())).lastInsertRowid;
  await audit(req.staff.name, 'Recorded payment (pending approval)', 'payment', id, `${member.member_no} ${S.fmtKes(amount)} ${reference}`);
  req.flash('success', `Payment recorded for ${member.first_name} ${member.last_name}. It posts once a manager or treasurer approves it.`);
  res.redirect('/admin/payments?status=pending');
});

router.post('/payments/:id/decision', async (req, res) => {
  const p = await one(`SELECT * FROM payments WHERE id = ? AND status = 'pending'`, idParam(req));
  if (!p) return res.redirect('/admin/payments');
  // Staff-entered payments need a manager or treasurer; codes members submit themselves can also be checked by a clerk.
  const mayApprove = res.locals.can.approvePayment || (p.submitted_by_member && req.staff.role === 'clerk');
  if (!mayApprove) return res.status(403).render('admin/denied', { title: 'Not allowed' });
  if (p.created_by === req.staff.id) {
    req.flash('danger', 'You recorded this payment, so someone else must approve it.');
    return res.redirect('/admin/payments?status=pending');
  }
  if (req.body.decision === 'approve') {
    await tx(async () => {
      await run(`UPDATE payments SET status = 'posted', approved_by = ? WHERE id = ?`, req.staff.id, p.id);
      for (const part of JSON.parse(p.note || '[]')) {
        const desc = part.account === 'loan' ? 'Loan repayment' : `${S.CHANNELS[p.channel]} · ${S.ACCOUNTS[part.account]}`;
        await run(`INSERT INTO transactions (member_id, payment_id, loan_id, account, amount, description, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)`,
          p.member_id, p.id, part.loan_id || null, part.account, part.amount, desc, p.created_at);
        if (part.loan_id) {
          const loan = await one('SELECT * FROM loans WHERE id = ?', part.loan_id);
          if ((await S.loanState(loan)).outstanding === 0) {
            await run(`UPDATE loans SET status = 'closed' WHERE id = ?`, loan.id);
            await logEvent(loan.id, 'closed', 'System', 'Loan fully repaid');
          }
        }
      }
    });
    await audit(req.staff.name, 'Approved payment', 'payment', p.id, `${S.fmtKes(p.amount)} ${p.reference}`);
    req.flash('success', `Payment ${p.reference} posted.`);
  } else {
    await run(`UPDATE payments SET status = 'rejected', approved_by = ? WHERE id = ?`, req.staff.id, p.id);
    await audit(req.staff.name, 'Rejected payment', 'payment', p.id, `${p.reference}: ${req.body.reason || 'no reason'}`);
    req.flash('success', `Payment ${p.reference} rejected.`);
  }
  res.redirect('/admin/payments?status=pending');
});

// ---------- Loans ----------
router.get('/loans', async (req, res) => {
  const rows = await all(`SELECT l.*, m.first_name || ' ' || m.last_name AS name, m.member_no, m.official_role, p.name AS product_name,
                          (SELECT COUNT(*) FROM guarantees g WHERE g.loan_id = l.id AND g.status = 'accepted') AS accepted,
                          (SELECT COUNT(*) FROM guarantees g WHERE g.loan_id = l.id) AS requested
                          FROM loans l JOIN members m ON m.id = l.member_id JOIN loan_products p ON p.code = l.product
                          WHERE l.status IN ('guarantors','appraisal','recommended','approved') ORDER BY l.applied_at`);
  const columns = ['guarantors', 'appraisal', 'recommended', 'approved'].map(s => ({ status: s, label: S.STATUS_LABELS[s], rows: rows.filter(r => r.status === s) }));
  const pf = await portfolio();
  const recent = await S.withState(await all(`SELECT l.*, m.first_name || ' ' || m.last_name AS name, p.name AS product_name FROM loans l JOIN members m ON m.id = l.member_id
                      JOIN loan_products p ON p.code = l.product WHERE l.status IN ('disbursed','closed','rejected') ORDER BY l.applied_at DESC LIMIT 15`));
  res.render('admin/loans', { title: 'Loans', columns, pf, recent });
});

router.get('/loans/:id', async (req, res, next) => {
  const loan = await one(`SELECT l.*, p.name AS product_name, m.official_role FROM loans l JOIN loan_products p ON p.code = l.product
                          JOIN members m ON m.id = l.member_id WHERE l.id = ?`, idParam(req));
  if (!loan) return next();
  loan.state = await S.loanState(loan);
  const appraisal = await S.appraise(loan);
  const events = await all('SELECT * FROM loan_events WHERE loan_id = ? ORDER BY created_at, id', loan.id);
  await Promise.all(appraisal.guarantees.map(async g => { g.capacity = await S.guarantorCapacity(g.guarantor_id); }));
  res.render('admin/loan', { title: `Loan #${loan.id}`, loan, appraisal, events });
});

function loanAction(action, from, to, check) {
  return async (req, res) => {
    const loan = await one('SELECT * FROM loans WHERE id = ?', idParam(req));
    if (!loan || loan.status !== from) return res.redirect('/admin/loans');
    const problem = check && await check(loan, req);
    if (problem) { req.flash('danger', problem); return res.redirect('/admin/loans/' + loan.id); }
    const note = String(req.body.note || '').trim();
    await tx(async () => {
      const col = { recommend: 'recommended_by', approve: 'approved_by', disburse: 'disbursed_by' }[action];
      await run(`UPDATE loans SET status = ?, ${col} = ?${action === 'disburse' ? ', disbursed_at = ?' : ''} WHERE id = ?`,
        ...(action === 'disburse' ? [to, req.staff.id, S.today(), loan.id] : [to, req.staff.id, loan.id]));
      await logEvent(loan.id, to, req.staff.name, note || { recommend: 'Recommended for approval', approve: 'Approved by credit committee', disburse: `Disbursed ${S.fmtKes(loan.principal - loan.fee)} (after ${S.fmtKes(loan.fee)} fee)` }[action]);
    });
    await audit(req.staff.name, `Loan ${action}`, 'loan', loan.id, note);
    req.flash('success', { recommend: 'Recommended and sent to the manager.', approve: 'Approved and sent to the treasurer for disbursement.', disburse: 'Disbursed. The repayment schedule starts next month.' }[action]);
    res.redirect('/admin/loans/' + loan.id);
  };
}

router.post('/loans/:id/recommend', allow('appraise'), loanAction('recommend', 'appraisal', 'recommended',
  async loan => (await S.appraise(loan)).passed ? null : 'Some appraisal checks fail. Resolve them or decline the loan.'));
router.post('/loans/:id/approve', allow('approveLoan'), loanAction('approve', 'recommended', 'approved',
  (loan, req) => loan.recommended_by === req.staff.id ? 'The person who recommended a loan can’t also approve it.' : null));
router.post('/loans/:id/disburse', allow('disburse'), loanAction('disburse', 'approved', 'disbursed',
  (loan, req) => loan.approved_by === req.staff.id ? 'The person who approved a loan can’t also disburse it.' : null));

router.post('/loans/:id/reject', allow('rejectLoan'), async (req, res) => {
  const loan = await one(`SELECT * FROM loans WHERE id = ? AND status IN ('guarantors','appraisal','recommended')`, idParam(req));
  const reason = String(req.body.reason || '').trim();
  if (!loan) return res.redirect('/admin/loans');
  if (!reason) { req.flash('danger', 'Give the member a reason for declining.'); return res.redirect('/admin/loans/' + loan.id); }
  await tx(async () => {
    await run(`UPDATE loans SET status = 'rejected', reject_reason = ? WHERE id = ?`, reason, loan.id);
    await logEvent(loan.id, 'rejected', req.staff.name, reason);
  });
  await audit(req.staff.name, 'Loan declined', 'loan', loan.id, reason);
  req.flash('success', 'Loan declined. Guarantors have been released.');
  res.redirect('/admin/loans/' + loan.id);
});

router.get('/arrears', async (req, res) => {
  const pf = await portfolio();
  const rows = pf.loans.filter(l => l.state.arrears > 0).sort((a, b) => b.state.daysInArrears - a.state.daysInArrears);
  const defaultAfter = setting('default_after_months');
  const bal = await S.balancesFor([...new Set(rows.map(l => l.member_id))]);
  for (const l of rows) {
    l.bucket = S.bucket(l.state.daysInArrears);
    // By-law 64(XXVI): month 1 letter to borrower (copy guarantors), month 2 warn guarantors, month 3 default.
    l.missed = Math.ceil(l.state.arrears / l.installment);
    l.stage = l.missed >= defaultAfter ? 'Declared in default: recover from guarantors'
      : l.missed === 2 ? 'Warn guarantors' : 'Letter to borrower, copy guarantors';
    l.shares = bal[l.member_id].deposits;
    l.lastPaid = (await one(`SELECT MAX(created_at) AS d FROM transactions WHERE loan_id = ? AND account = 'loan'`, l.id)).d;
    l.guarantors = await all(`SELECT g.amount, m.first_name || ' ' || m.last_name AS name, m.phone FROM guarantees g JOIN members m ON m.id = g.guarantor_id
                              WHERE g.loan_id = ? AND g.status = 'accepted'`, l.id);
  }
  const buckets = ['1 to 30 days', '31 to 60 days', '61 to 90 days', '90+ days'].map(b => ({
    label: b, count: rows.filter(r => r.bucket === b).length, amount: rows.filter(r => r.bucket === b).reduce((s, r) => s + r.state.outstanding, 0),
  }));
  res.render('admin/arrears', { title: 'Arrears', rows, buckets, pf });
});

// ---------- Approvals inbox ----------
router.get('/approvals', async (req, res) => {
  const members = await all(`SELECT m.*, s.name AS maker FROM members m LEFT JOIN staff s ON s.id = m.created_by WHERE m.status = 'pending' ORDER BY m.created_at`);
  const payments = await all(`SELECT p.*, m.first_name || ' ' || m.last_name AS name, m.member_no, COALESCE(s.name, 'the member') AS maker FROM payments p
                              JOIN members m ON m.id = p.member_id LEFT JOIN staff s ON s.id = p.created_by WHERE p.status = 'pending' ORDER BY p.created_at`);
  for (const p of payments) p.split = JSON.parse(p.note || '[]');
  const loans = await all(`SELECT l.*, m.first_name || ' ' || m.last_name AS name, p.name AS product_name FROM loans l JOIN members m ON m.id = l.member_id
                           JOIN loan_products p ON p.code = l.product WHERE l.status IN ('appraisal','recommended','approved') ORDER BY l.applied_at`);
  const requests = (await all(`SELECT r.*, m.first_name || ' ' || m.last_name AS name, m.member_no, m.payroll_no FROM requests r JOIN members m ON m.id = r.member_id
                               WHERE r.status = 'pending' ORDER BY r.created_at`)).map(r => ({ ...r, d: JSON.parse(r.details) }));
  res.render('admin/approvals', { title: 'My work', members, payments, loans, requests });
});

router.post('/requests/:id', allow('handleRequests'), async (req, res) => {
  const r = await one(`SELECT * FROM requests WHERE id = ? AND status = 'pending'`, idParam(req));
  if (!r) return res.redirect('/admin/approvals');
  const approved = req.body.decision === 'approve';
  const isNominee = r.type === 'nominee_change';
  await tx(async () => {
    await run('UPDATE requests SET status = ?, handled_by = ? WHERE id = ?', approved ? 'approved' : 'rejected', req.staff.id, r.id);
    // A confirmed nominee change replaces the member's nominees.
    if (approved && isNominee) {
      await run('DELETE FROM nominees WHERE member_id = ?', r.member_id);
      for (const n of JSON.parse(r.details).nominees) {
        await run('INSERT INTO nominees (member_id, name, relationship, id_number, phone, address, share_pct) VALUES (?, ?, ?, ?, ?, ?, ?)',
          r.member_id, n.name, n.relationship, n.id_number || null, n.phone || null, n.address || null, n.share_pct);
      }
    }
  });
  const what = isNominee ? 'Nominee change' : 'Deduction change';
  await audit(req.staff.name, `${what} ${approved ? (isNominee ? 'confirmed' : 'actioned') : 'rejected'}`, 'member', r.member_id, r.details);
  req.flash('success', !approved ? 'Request rejected. The member can see this in their portal.'
    : isNominee ? 'Nominees updated. The member’s new nominees are now on file.' : 'Marked as done. Remember to update the payroll check-off schedule.');
  res.redirect('/admin/approvals');
});

// ---------- Messages from the public Contact page ----------
router.get('/messages', async (req, res) => {
  const show = req.query.show === 'answered' ? 'answered' : 'new';
  const rows = await all(`SELECT c.*, s.name AS handler FROM contact_messages c LEFT JOIN staff s ON s.id = c.handled_by
                          WHERE c.status = ? ORDER BY c.created_at DESC LIMIT 200`, show);
  res.render('admin/messages', { title: 'Messages', rows, show });
});

router.post('/messages/:id/answered', allow('answerMessages'), async (req, res) => {
  const { changes } = await run(`UPDATE contact_messages SET status = 'answered', handled_by = ?, handled_at = ? WHERE id = ? AND status = 'new'`,
    req.staff.id, S.now(), idParam(req));
  if (changes) await audit(req.staff.name, 'Answered contact message', 'message', idParam(req));
  res.redirect('/admin/messages');
});

// ---------- Settings & audit ----------
router.get('/settings', async (req, res) => {
  res.render('admin/settings', {
    title: 'Products & rules',
    settings: await all('SELECT * FROM settings ORDER BY position'),
    products: await all('SELECT * FROM loan_products ORDER BY position'),
    staffList: await all('SELECT * FROM staff ORDER BY id'),
    ROLE_LABELS,
  });
});

router.post('/settings', allow('settings'), async (req, res) => {
  const changes = [];
  await tx(async () => {
    for (const s of await all('SELECT * FROM settings')) {
      const v = req.body['s_' + s.key];
      if (v !== undefined && v !== '' && !isNaN(Number(v)) && Number(v) !== Number(s.value)) {
        await run('UPDATE settings SET value = ? WHERE key = ?', String(Number(v)), s.key);
        changes.push(`${s.label}: ${s.value} → ${Number(v)}`);
      }
    }
    for (const p of await all('SELECT * FROM loan_products')) {
      const field = k => req.body[`p_${p.code}_${k}`];
      const rate = Number(field('rate')) / 100, months = parseInt(field('months'), 10), mult = Number(field('multiplier'));
      const guar = parseInt(field('guarantors'), 10), fee = Number(field('fee'));
      if ([rate, months, mult, guar, fee].some(n => isNaN(n))) continue;
      if (rate !== p.rate_monthly || months !== p.max_months || mult !== p.multiplier || guar !== p.min_guarantors || fee !== p.fee_pct) {
        await run('UPDATE loan_products SET rate_monthly = ?, max_months = ?, multiplier = ?, min_guarantors = ?, fee_pct = ? WHERE code = ?', rate, months, mult, guar, fee, p.code);
        changes.push(`${p.name}: ${(p.rate_monthly * 100).toFixed(2)}%/${p.max_months}m/${p.multiplier}×/${p.min_guarantors}g/${p.fee_pct}% → ${(rate * 100).toFixed(2)}%/${months}m/${mult}×/${guar}g/${fee}%`);
      }
    }
  });
  if (changes.length) await audit(req.staff.name, 'Changed rules', 'settings', null, changes.join('; '));
  req.flash('success', changes.length ? `Saved ${changes.length} change(s). Existing loans keep their original terms.` : 'Nothing changed.');
  res.redirect('/admin/settings');
});

// ---------- Downloads for Excel ----------
// Each report is a CSV that opens in Excel or Google Sheets, ready for pivot tables and charts.
// Dated reports take ?from=YYYY-MM-DD&to=YYYY-MM-DD (default: the last 12 months).
const dateParam = (v, fallback) => /^\d{4}-\d{2}-\d{2}$/.test(String(v || '')) ? String(v) : fallback;

const REPORTS = {
  members: {
    label: 'Members and balances',
    async build() {
      const rows = await all(`SELECT * FROM members WHERE status != 'rejected' ORDER BY member_no`);
      const bal = await S.balancesFor(rows.map(m => m.id));
      return [['Member no', 'First name', 'Last name', 'Status', 'Official seat', 'Phone', 'Email', 'Employer', 'Department', 'Payroll no', 'Terms', 'Joined',
        'Share capital', 'Deposits', 'Holiday savings', 'Family savings'],
      rows.map(m => [m.member_no, m.first_name, m.last_name, m.status, m.official_role, m.phone, m.email, m.employer, m.department, m.payroll_no, m.terms,
        m.joined_at, bal[m.id].shares, bal[m.id].deposits, bal[m.id].holiday, bal[m.id].family])];
    },
  },
  loans: {
    label: 'Loans',
    async build() {
      const loans = await S.withState(await all(`SELECT l.*, m.member_no, m.first_name || ' ' || m.last_name AS name, m.official_role, p.name AS product_name
                                                 FROM loans l JOIN members m ON m.id = l.member_id JOIN loan_products p ON p.code = l.product ORDER BY l.id`));
      return [['Loan no', 'Member no', 'Borrower', 'Official', 'Product', 'Status', 'Principal', 'Months', 'Interest % a month', 'Installment', 'Total to repay',
        'Applied', 'Disbursed', 'Paid so far', 'Balance', 'Overdue amount', 'Days overdue', 'Arrears band'],
      loans.map(l => [l.id, l.member_no, l.name, l.official_role ? 'Yes' : '', l.product_name, S.STATUS_LABELS[l.status] || l.status, l.principal, l.months,
        +(l.rate_monthly * 100).toFixed(2), l.installment, l.total_payable, String(l.applied_at).slice(0, 10), l.disbursed_at,
        l.state.paid, l.state.outstanding, l.state.arrears, l.state.daysInArrears, l.status === 'disbursed' ? S.bucket(l.state.daysInArrears) : ''])];
    },
  },
  payments: {
    label: 'Payments',
    dated: true,
    async build(from, to) {
      const rows = await all(`SELECT p.*, m.member_no, m.first_name || ' ' || m.last_name AS name,
                              COALESCE(s.name, CASE WHEN p.submitted_by_member THEN 'Member (code)' END) AS maker, a.name AS checker
                              FROM payments p JOIN members m ON m.id = p.member_id LEFT JOIN staff s ON s.id = p.created_by LEFT JOIN staff a ON a.id = p.approved_by
                              WHERE p.created_at::date BETWEEN ? AND ? ORDER BY p.created_at`, from, to);
      return [['Date', 'Member no', 'Member', 'Channel', 'Reference', 'Amount', 'Status', 'Recorded by', 'Approved by'],
        rows.map(p => [String(p.created_at).slice(0, 10), p.member_no, p.name, S.CHANNELS[p.channel], p.reference, p.amount, p.status, p.maker, p.checker])];
    },
  },
  transactions: {
    label: 'Every transaction (ledger)',
    dated: true,
    async build(from, to) {
      const rows = await all(`SELECT t.*, m.member_no, m.first_name || ' ' || m.last_name AS name FROM transactions t JOIN members m ON m.id = t.member_id
                              WHERE t.created_at::date BETWEEN ? AND ? ORDER BY t.created_at, t.id`, from, to);
      return [['Date', 'Month', 'Member no', 'Member', 'Account', 'Loan no', 'Description', 'Amount'],
        rows.map(t => [String(t.created_at).slice(0, 10), String(t.created_at).slice(0, 7), t.member_no, t.name,
          t.account === 'loan' ? 'Loan repayment' : S.ACCOUNTS[t.account] || t.account, t.loan_id, t.description, t.amount])];
    },
  },
  monthly: {
    label: 'Monthly totals (for charts)',
    dated: true,
    async build(from, to) {
      // Money in and money out are kept apart, so a withdrawal doesn't show up as negative "paid in".
      const money = await all(`SELECT to_char(created_at, 'YYYY-MM') AS month, account, SUM(GREATEST(amount, 0)) AS total, SUM(LEAST(amount, 0)) AS out
                               FROM transactions WHERE created_at::date BETWEEN ? AND ? GROUP BY 1, 2`, from, to);
      const lent = await all(`SELECT to_char(disbursed_at, 'YYYY-MM') AS month, COUNT(*) AS n, SUM(principal) AS total FROM loans
                              WHERE disbursed_at BETWEEN ? AND ? GROUP BY 1`, from, to);
      const joined = await all(`SELECT to_char(joined_at, 'YYYY-MM') AS month, COUNT(*) AS n FROM members WHERE joined_at BETWEEN ? AND ? GROUP BY 1`, from, to);
      const months = [];
      for (let m = from.slice(0, 7); m <= to.slice(0, 7); m = S.addMonths(m + '-01', 1).slice(0, 7)) months.push(m);
      const get = (list, month, key = 'total', extra = () => true) => (list.find(r => r.month === month && extra(r)) || {})[key] || 0;
      return [['Month', 'New members', 'Share capital paid in', 'Deposits paid in', 'Holiday savings paid in', 'Family savings paid in', 'Loan repayments', 'Savings withdrawn', 'Loans paid out (number)', 'Loans paid out (KES)'],
        months.map(m => [m, get(joined, m, 'n'),
          ...['shares', 'deposits', 'holiday', 'family', 'loan'].map(acc => get(money, m, 'total', r => r.account === acc)),
          -money.filter(r => r.month === m && r.account !== 'loan').reduce((sum, r) => sum + r.out, 0),
          get(lent, m, 'n'), get(lent, m)])];
    },
  },
  audit: {
    label: 'Audit trail',
    dated: true,
    async build(from, to) {
      const rows = await all(`SELECT * FROM audit WHERE created_at::date BETWEEN ? AND ? ORDER BY id`, from, to);
      return [['When', 'Who', 'Action', 'Record', 'Details'],
        rows.map(a => [String(a.created_at), a.actor, a.action, a.entity_id ? `${a.entity} #${a.entity_id}` : a.entity, a.details])];
    },
  },
};

router.get('/export/:report', allow('export'), async (req, res, next) => {
  const report = REPORTS[req.params.report];
  if (!report) return next();
  const to = dateParam(req.query.to, S.today());
  const from = dateParam(req.query.from, S.addMonths(to, -12));
  const [headers, rows] = await report.build(from, to);
  const range = report.dated ? `${from}_to_${to}` : S.today();
  await audit(req.staff.name, 'Downloaded report', 'report', null, `${report.label}${report.dated ? ` (${from} to ${to})` : ''}, ${rows.length} rows`);
  sendCsv(res, `deseret-sacco_${req.params.report}_${range}.csv`, headers, rows);
});

// ---------- Staff logins and handover ----------
// A leadership or staff login belongs to the office. At handover the manager switches off
// the outgoing person's login and adds one for the successor. Their member account is untouched.
router.get('/change-password', (req, res) => res.render('admin/change-password', { title: 'Choose your password', error: null }));

router.post('/change-password', async (req, res) => {
  const fresh = String(req.body.next || ''), confirm = String(req.body.confirm || '');
  const error = fresh.length < 10 ? 'Use at least 10 characters.'
    : fresh !== confirm ? 'The two passwords don’t match.'
    : null;
  if (error) return res.status(400).render('admin/change-password', { title: 'Choose your password', error });
  await run('UPDATE staff SET password_hash = ?, must_change_password = false WHERE id = ?', hashPassword(fresh), req.staff.id);
  await audit(req.staff.name, 'Set first password', 'staff', req.staff.id);
  req.flash('success', 'Password saved.');
  res.redirect('/admin');
});

router.post('/staff', allow('settings'), async (req, res) => {
  const name = String(req.body.name || '').trim().slice(0, 100);
  const email = String(req.body.email || '').trim().toLowerCase().slice(0, 200);
  const role = String(req.body.role || '');
  const error = !name ? 'Enter their name.'
    : !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email) ? 'Enter a valid email address.'
    : !ROLE_LABELS[role] ? 'Choose a role.'
    : await one('SELECT id FROM staff WHERE email = ?', email) ? 'That email already has a login.'
    : null;
  if (error) { req.flash('danger', error); return res.redirect('/admin/settings#staff'); }
  // A one-time password the manager passes on in person; it must be replaced at first sign-in.
  const temp = crypto.randomBytes(6).toString('base64url');
  await run('INSERT INTO staff (name, email, role, password_hash, must_change_password) VALUES (?, ?, ?, ?, true)', name, email, role, hashPassword(temp));
  await audit(req.staff.name, 'Added staff login', 'staff', null, `${name} (${ROLE_LABELS[role]}, ${email})`);
  req.flash('success', `Login added for ${name}. Give them this one-time password in person: ${temp}. They will choose their own when they first sign in.`);
  res.redirect('/admin/settings#staff');
});

const switchStaff = on => async (req, res) => {
  const target = await one('SELECT * FROM staff WHERE id = ?', idParam(req));
  if (!target || target.id === req.staff.id) { req.flash('danger', 'You can’t switch off your own login.'); return res.redirect('/admin/settings#staff'); }
  await run('UPDATE staff SET active = ? WHERE id = ?', on, target.id);
  await audit(req.staff.name, on ? 'Switched on staff login' : 'Switched off staff login', 'staff', target.id, `${target.name} (${ROLE_LABELS[target.role]})`);
  req.flash('success', on ? `${target.name} can sign in again.` : `${target.name} can no longer sign in. Their member account (if any) is unchanged.`);
  res.redirect('/admin/settings#staff');
};
router.post('/staff/:id/off', allow('settings'), switchStaff(false));
router.post('/staff/:id/on', allow('settings'), switchStaff(true));

// ---------- Officials ----------
router.post('/members/:id/official', allow('approveMember'), async (req, res) => {
  const m = await one('SELECT * FROM members WHERE id = ?', idParam(req));
  if (!m) return res.redirect('/admin/members');
  const role = S.OFFICIAL_ROLES.includes(req.body.role) ? req.body.role : null;
  await run('UPDATE members SET official_role = ? WHERE id = ?', role, m.id);
  await audit(req.staff.name, role ? 'Marked as official' : 'Removed official tag', 'member', m.id, role || m.official_role);
  req.flash('success', role ? `${m.first_name} ${m.last_name} is now marked as ${role}.` : `${m.first_name} ${m.last_name} is no longer marked as an official.`);
  res.redirect('/admin/members/' + m.id);
});

router.get('/audit', async (req, res) => {
  const q = String(req.query.q || '').trim();
  const like = `%${q}%`;
  const rows = await all(`SELECT * FROM audit WHERE (?::text = '' OR actor ILIKE ? OR action ILIKE ? OR details ILIKE ?) ORDER BY id DESC LIMIT 300`, q, like, like, like);
  res.render('admin/audit', { title: 'Audit trail', rows, q });
});

module.exports = router;
