const crypto = require('crypto');
const express = require('express');
const { one, all, run, tx, setting, audit } = require('../db');
const { checkPassword, hashPassword, requireMember } = require('../lib/auth');
const S = require('../lib/sacco');
const { sendCsv } = require('../lib/csv');
const { whereFrom } = require('../lib/where');
const M = require('../lib/mpesa');
const { refresh } = require('./mpesa');
const { lockedFor, recordFailure, clearFailures } = require('../lib/security');

const router = express.Router();

const logEvent = (loanId, step, actor, note) =>
  run('INSERT INTO loan_events (loan_id, step, actor, note, created_at) VALUES (?, ?, ?, ?, ?)', loanId, step, actor, note || null, S.now());
const fullName = m => `${m.first_name} ${m.last_name}`;

const products = () => all('SELECT * FROM loan_products ORDER BY position');
const withEligibility = async (member, list, topupOf) => {
  const position = await S.borrowerPosition(member);
  return Promise.all(list.map(async p => ({ ...p, ...await S.eligibility(member, p, position, topupOf) })));
};

// A top-up must be on one of the member's own active loans with no arrears.
// The new loan is the same product, and its payout first clears what's left on the old one.
async function topupTarget(member, id) {
  if (!id) return null;
  const loan = (await S.memberLoans(member.id, ['disbursed'])).find(l => l.id === Number(id));
  if (!loan || loan.state.arrears > 0) return null;
  return { ...loan, clears: S.payoff(loan, loan.state.paid) };
}

// The products a member may apply for: all of them, or only the old loan's product for a top-up.
async function applyOptions(member, topup) {
  const list = await withEligibility(member, await products(), topup && topup.id);
  if (!topup) return list;
  return list.filter(p => p.code === topup.product).map(p => ({ ...p, max: p.max > topup.clears ? p.max : 0,
    reasons: p.max > topup.clears ? p.reasons : [...p.reasons, `You can’t borrow more than the ${S.fmtKes(topup.clears)} you still owe right now.`] }));
}

router.get('/login', (req, res) => {
  if (req.session.memberId) return res.redirect('/portal');
  res.render('portal/login', { error: null, memberNo: '' });
});

router.post('/login', async (req, res) => {
  const memberNo = String(req.body.memberNo || '').trim().toUpperCase().slice(0, 20);
  const locked = await lockedFor('member', memberNo, req);
  if (locked) return res.status(429).render('portal/login', { error: `Too many wrong passwords. Try again in ${locked} minute${locked === 1 ? '' : 's'} or call the office.`, memberNo });
  const member = await one(`SELECT * FROM members WHERE member_no = ? AND status IN ('active','exiting')`, memberNo);
  if (!member || !checkPassword(String(req.body.password || ''), member.password_hash)) {
    await recordFailure('member', memberNo, req);
    if (member) await audit(fullName(member), 'Failed member sign-in', 'member', member.id, whereFrom(req, { ip: true }));
    return res.status(401).render('portal/login', { error: 'Member number or password is incorrect.', memberNo });
  }
  await clearFailures('member', memberNo);
  await req.startSession({ memberId: member.id, lastLogin: member.last_login, lastLoginFrom: member.last_login_from });
  await run(`UPDATE members SET last_login = ?, last_login_from = ? WHERE id = ?`, S.now(), whereFrom(req), member.id);
  await audit(fullName(member), 'Member signed in', 'member', member.id, whereFrom(req, { ip: true }));
  res.redirect('/portal');
});

router.get('/logout', async (req, res) => {
  await req.endSession();
  res.redirect('/portal/login');
});

router.get('/forgot-password', (req, res) => res.render('portal/forgot-password'));
router.get('/signup', (req, res) => res.redirect('/join'));

router.use(requireMember);

// Everything below needs a signed-in member; load them once per request.
router.use(async (req, res, next) => {
  const member = await one('SELECT * FROM members WHERE id = ?', req.session.memberId);
  if (!member) { await req.endSession(); return res.redirect('/portal/login'); }
  req.member = member;
  res.locals.member = member;
  // New members sign in with their ID number first and must choose their own password.
  if (member.must_change_password && !['/change-password', '/logout'].includes(req.path)) return res.redirect('/portal/change-password');
  res.locals.pendingGuarantees = (await one(`SELECT COUNT(*) AS n FROM guarantees g JOIN loans l ON l.id = g.loan_id
    WHERE g.guarantor_id = ? AND g.status = 'pending' AND l.status = 'guarantors'`, member.id)).n;
  res.locals.path = req.originalUrl;
  next();
});

router.get('/change-password', (req, res) => res.render('portal/change-password', { title: 'Choose your password', error: null }));

router.post('/change-password', async (req, res) => {
  const fresh = String(req.body.next || ''), confirm = String(req.body.confirm || '');
  const error = fresh.length < 8 ? 'Use at least 8 characters.'
    : fresh !== confirm ? 'The two passwords don’t match.'
    : fresh === req.member.id_number ? 'Choose something other than your ID number.'
    : null;
  if (error) return res.status(400).render('portal/change-password', { title: 'Choose your password', error });
  await run('UPDATE members SET password_hash = ?, must_change_password = false WHERE id = ?', hashPassword(fresh), req.member.id);
  await audit(fullName(req.member), 'Set first password', 'member', req.member.id);
  req.flash('success', 'Password saved. Welcome to the member portal.');
  res.redirect('/portal');
});

router.get('/', async (req, res) => {
  const m = req.member;
  const [bal, loans, eligibility, goals, recent, capacity, guaranteed] = await Promise.all([
    S.balances(m.id),
    S.memberLoans(m.id),
    products().then(list => withEligibility(m, list)),
    all('SELECT * FROM goals WHERE member_id = ?', m.id),
    all(`SELECT p.*, (SELECT COUNT(*) FROM transactions t WHERE t.payment_id = p.id) AS parts FROM payments p
         WHERE p.member_id = ? ORDER BY p.created_at DESC LIMIT 5`, m.id),
    S.guarantorCapacity(m.id),
    guaranteedLoans(m.id),
  ]);
  const owed = loans.reduce((s, l) => s + (l.status === 'disbursed' ? l.state.outstanding : 0), 0);
  res.render('portal/dashboard', {
    title: 'Overview', minShares: setting('min_share_capital'), bal, loans, owed, eligibility, goals, recent, capacity, guaranteed,
    worth: bal.shares + bal.deposits + bal.holiday + bal.family - owed,
    lastLogin: req.session.lastLogin,
    lastLoginFrom: req.session.lastLoginFrom,
  });
});

async function guaranteedLoans(memberId) {
  return S.withState(await all(`SELECT g.amount, g.status AS g_status, l.*, m.first_name || ' ' || m.last_name AS borrower, p.name AS product_name
              FROM guarantees g JOIN loans l ON l.id = g.loan_id JOIN members m ON m.id = l.member_id JOIN loan_products p ON p.code = l.product
              WHERE g.guarantor_id = ? AND g.status = 'accepted' AND l.status IN ('guarantors','appraisal','recommended','approved','disbursed')
              ORDER BY l.applied_at DESC`, memberId));
}

router.get('/accounts/:account', async (req, res, next) => {
  const account = req.params.account;
  if (!S.ACCOUNTS[account]) return next();
  const from = /^\d{4}-\d{2}-\d{2}$/.test(req.query.from) ? req.query.from : S.addMonths(S.today(), -12);
  const to = /^\d{4}-\d{2}-\d{2}$/.test(req.query.to) ? req.query.to : S.today();
  const rows = await all(`SELECT t.*, p.channel, p.reference FROM transactions t LEFT JOIN payments p ON p.id = t.payment_id
                          WHERE t.member_id = ? AND t.account = ? AND t.created_at::date BETWEEN ? AND ? ORDER BY t.created_at DESC`,
    req.member.id, account, from, to);
  const opening = (await one(`SELECT COALESCE(SUM(amount), 0) AS b FROM transactions WHERE member_id = ? AND account = ? AND created_at::date < ?`,
    req.member.id, account, from)).b;
  let running = opening + rows.reduce((s, r) => s + r.amount, 0);
  const closing = running;
  for (const r of rows) { r.balance = running; running -= r.amount; }
  if (req.query.format === 'csv') {
    return sendCsv(res, `deseret-sacco_${req.member.member_no}_${account}_${from}_to_${to}.csv`,
      ['Date', 'Description', 'Channel', 'Reference', 'Amount', 'Balance'],
      [[from, 'Opening balance', '', '', '', opening],
        ...rows.slice().reverse().map(r => [String(r.created_at).slice(0, 10), r.description, r.channel ? S.CHANNELS[r.channel] : '', r.reference, r.amount, r.balance])]);
  }
  const goal = await one('SELECT * FROM goals WHERE member_id = ? AND account = ?', req.member.id, account);
  const view = req.query.print ? 'portal/statement' : 'portal/account';
  res.render(view, { title: S.ACCOUNTS[account], account, rows, from, to, opening, closing, goal, balance: (await S.balances(req.member.id))[account] });
});

router.post('/goals/:account', async (req, res) => {
  const account = req.params.account;
  const target = parseInt(req.body.target, 10);
  if (['holiday', 'family'].includes(account) && target > 0 && req.body.target_date) {
    await run(`INSERT INTO goals (member_id, account, target, target_date) VALUES (?, ?, ?, ?)
               ON CONFLICT (member_id, account) DO UPDATE SET target = excluded.target, target_date = excluded.target_date`,
      req.member.id, account, target, req.body.target_date);
    req.flash('success', 'Goal saved.');
  }
  res.redirect('/portal/accounts/' + account);
});

router.get('/payments', async (req, res) => {
  const payments = await all('SELECT * FROM payments WHERE member_id = ? ORDER BY created_at DESC LIMIT 60', req.member.id);
  const parts = await all(`SELECT t.*, l.product FROM transactions t LEFT JOIN loans l ON l.id = t.loan_id
                           WHERE t.member_id = ? AND t.payment_id IS NOT NULL`, req.member.id);
  for (const p of payments) {
    p.parts = p.status === 'posted' ? parts.filter(t => t.payment_id === p.id) : JSON.parse(p.note || '[]');
  }
  res.render('portal/payments', { title: 'Payments', payments });
});

router.get('/deposit', async (req, res) => {
  const loans = await S.memberLoans(req.member.id, ['disbursed']);
  res.render('portal/deposit', { title: 'Make a payment', loans, preset: req.query, mpesaLive: M.LIVE });
});

// Members pay through the Co-op Bank Paybill, then submit the M-Pesa code here instead of forwarding the SMS.
// Staff match the code against the bank statement before it posts.
// ---------- M-Pesa prompt (STK Push) ----------
// The member picks an amount, gets a PIN prompt on their phone, and the payment posts once Safaricom confirms it.
router.post('/mpesa', async (req, res) => {
  const amount = parseInt(req.body.amount, 10);
  const target = String(req.body.target || 'deposits');
  const phone = M.normalisePhone(req.body.phone);
  const loans = await S.memberLoans(req.member.id, ['disbursed']);
  const loan = target.startsWith('loan:') ? loans.find(l => l.id === Number(target.slice(5))) : null;
  const fail = msg => { req.flash('danger', msg); return res.redirect('/portal/deposit'); };
  if (!(amount >= 1 && amount <= 150000) || (!S.ACCOUNTS[target] && !loan)) return fail('Enter an amount between KES 1 and KES 150,000.');
  if (!phone) return fail('Enter a Safaricom number, for example 0722 123 456.');
  if (await one(`SELECT 1 AS x FROM mpesa_requests WHERE member_id = ? AND status = 'pending' AND created_at > now() - interval '1 minute'`, req.member.id)) {
    return fail('A prompt was just sent. Check your phone, or wait a minute before trying again.');
  }
  const split = JSON.stringify([loan ? { account: 'loan', loan_id: loan.id, amount } : { account: target, amount }]);
  let checkout;
  if (M.configured()) {
    const host = process.env.PUBLIC_URL || `https://${req.get('host')}`;
    checkout = await M.stkPush({ phone, amount, accountRef: req.member.member_no, description: 'SACCO payment',
      callbackUrl: `${host}/mpesa/callback/${M.callbackToken()}` }).catch(() => ({ error: 'Could not reach M-Pesa. Please try again.' }));
    if (checkout.error) return fail(checkout.error);
  } else if (res.locals.demo) {
    checkout = { checkoutRequestId: 'SIM-' + crypto.randomBytes(8).toString('hex'), simulated: true };
  } else {
    return fail('M-Pesa prompts aren’t switched on yet. Please pay by Paybill below.');
  }
  const r = await one(`INSERT INTO mpesa_requests (member_id, phone, amount, split, checkout_request_id, merchant_request_id, simulated, created_at)
                       VALUES (?, ?, ?, ?, ?, ?, ?, ?) RETURNING id`,
    req.member.id, phone, amount, split, checkout.checkoutRequestId, checkout.merchantRequestId || null, !!checkout.simulated, S.now());
  await audit(fullName(req.member), 'Sent M-Pesa prompt', 'member', req.member.id, `${S.fmtKes(amount)} to ${phone.slice(0, 6)}***${phone.slice(-3)}`);
  res.redirect('/portal/mpesa/' + r.id);
});

const myPrompt = req => one('SELECT * FROM mpesa_requests WHERE id = ? AND member_id = ?', Number(req.params.id) || 0, req.member.id);

router.get('/mpesa/:id', async (req, res, next) => {
  const r = await myPrompt(req);
  if (!r) return next();
  // Offer the app after the member's first M-Pesa payment (every payment in the demo, so it can be shown).
  const earlier = await one(`SELECT 1 AS x FROM mpesa_requests WHERE member_id = ? AND status = 'paid' AND id < ?`, req.member.id, r.id);
  res.render('portal/mpesa-wait', { title: 'Check your phone', r, live: M.LIVE, firstPayment: !earlier || res.locals.demo });
});

router.get('/mpesa/:id/status', async (req, res) => {
  let r = await myPrompt(req);
  if (!r) return res.status(404).json({});
  r = await refresh(r);
  res.json({ status: r.status, message: r.result_desc || '', receipt: r.receipt || '' });
});

router.post('/deposit', async (req, res) => {
  const amount = parseInt(req.body.amount, 10);
  const target = String(req.body.target || 'deposits');
  const code = String(req.body.code || '').trim().toUpperCase();
  const loans = await S.memberLoans(req.member.id, ['disbursed']);
  const loan = target.startsWith('loan:') ? loans.find(l => l.id === Number(target.slice(5))) : null;
  if (!(amount >= 10 && amount <= 150000) || (!S.ACCOUNTS[target] && !loan)) {
    req.flash('danger', 'Enter the amount you paid (KES 10 to 150,000).');
    return res.redirect('/portal/deposit');
  }
  if (!/^[A-Z0-9]{10}$/.test(code)) {
    req.flash('danger', 'The M-Pesa code is the 10-character code at the start of the SMS, e.g. TJK4X8B2QP.');
    return res.redirect('/portal/deposit');
  }
  if (await one(`SELECT 1 AS x FROM payments WHERE reference = ? AND channel = 'mpesa'`, code)) {
    req.flash('danger', 'That M-Pesa code has already been submitted.');
    return res.redirect('/portal/deposit');
  }
  const split = [loan ? { account: 'loan', loan_id: loan.id, amount } : { account: target, amount }];
  await run(`INSERT INTO payments (member_id, amount, channel, reference, status, submitted_by_member, note, created_at) VALUES (?, ?, 'mpesa', ?, 'pending', true, ?, ?)`,
    req.member.id, amount, code, JSON.stringify(split), S.now());
  await audit(fullName(req.member), 'Submitted M-Pesa code', 'member', req.member.id, `${S.fmtKes(amount)} ${code}`);
  req.flash('success', `Thanks. ${code} for ${S.fmtKes(amount)} is with the office for verification. You’ll see it in your balance once confirmed.`);
  res.redirect('/portal/payments');
});

// The "Authority to make deductions (variations)" form, online.
router.post('/deductions', async (req, res) => {
  const n = k => Math.max(parseInt(req.body[k], 10) || 0, 0);
  const details = { shares_from: n('shares_from'), shares_to: n('shares_to'), loan_from: n('loan_from'), loan_to: n('loan_to'), effective: String(req.body.effective || '') };
  if (!details.effective || (!details.shares_to && !details.loan_to)) {
    req.flash('danger', 'Enter the new monthly amount and the month it should start.');
    return res.redirect('/portal/profile#deductions');
  }
  await run(`INSERT INTO requests (member_id, type, details, created_at) VALUES (?, 'deduction_change', ?, ?)`, req.member.id, JSON.stringify(details), S.now());
  await audit(fullName(req.member), 'Requested deduction change', 'member', req.member.id, JSON.stringify(details));
  req.flash('success', 'Request sent. The office will update your deductions from the month you chose.');
  res.redirect('/portal/profile#deductions');
});

router.get('/loans', async (req, res) => {
  const m = req.member;
  const loans = await S.memberLoans(m.id, ['guarantors', 'appraisal', 'recommended', 'approved', 'disbursed', 'closed', 'rejected']);
  res.render('portal/loans', { title: 'Loans', loans, products: await withEligibility(m, await products()) });
});

router.get('/loans/apply', async (req, res) => {
  const topup = await topupTarget(req.member, req.query.topup);
  const list = await applyOptions(req.member, topup);
  const selected = list.find(p => p.code === req.query.product) || list.find(p => p.max > 0) || list[0];
  const ownFree = (await S.guarantorCapacity(req.member.id)).free;
  res.render('portal/apply', { title: topup ? 'Top up a loan' : 'Apply for a loan', products: list, selected, error: null, form: {}, ownFree, topup });
});

router.post('/loans/apply', async (req, res) => {
  const m = req.member;
  const topup = await topupTarget(m, req.body.topup_of);
  if (req.body.topup_of && !topup) { req.flash('danger', 'That loan can’t be topped up. Clear any arrears first.'); return res.redirect('/portal/loans'); }
  const list = await applyOptions(m, topup);
  const product = list.find(p => p.code === req.body.product);
  const principal = parseInt(req.body.amount, 10);
  const months = parseInt(req.body.months, 10);
  const guarantorNos = [].concat(req.body.guarantor_no || []).map(s => String(s).trim().toUpperCase()).filter(Boolean);
  const guarantorAmts = [].concat(req.body.guarantor_amount || []).map(n => parseInt(n, 10) || 0);
  const ownFree = (await S.guarantorCapacity(m.id)).free;
  const fail = error => res.status(400).render('portal/apply', { title: topup ? 'Top up a loan' : 'Apply for a loan', products: list, selected: product || list[0], error, form: req.body, ownFree, topup });

  if (!product) return fail('Choose a loan product.');
  if (product.reasons.length) return fail(product.reasons[0]);
  if (!(principal >= 1000)) return fail('Enter the amount you want to borrow.');
  if (principal > product.max) return fail(`The most you can borrow on ${product.name} right now is ${S.fmtKes(product.max)}.`);
  if (!(months >= 1 && months <= product.max_months)) return fail(`Choose between 1 and ${product.max_months} months.`);
  if (topup && principal <= topup.clears) return fail(`A top-up has to be more than the ${S.fmtKes(topup.clears)} you still owe.`);

  const guarantors = [];
  for (let i = 0; i < guarantorNos.length; i++) {
    const g = await one(`SELECT * FROM members WHERE member_no = ? AND status = 'active'`, guarantorNos[i]);
    if (!g) return fail(`${guarantorNos[i]} is not an active member number.`);
    if (g.id === m.id) return fail('You can’t guarantee your own loan.');
    if (g.official_role) return fail(`${guarantorNos[i]} is a SACCO official (${g.official_role}). Officials can’t guarantee loans (By-law 69).`);
    if (guarantors.some(x => x.id === g.id)) return fail(`${guarantorNos[i]} is listed twice.`);
    if (!(guarantorAmts[i] > 0)) return fail(`Enter how much ${guarantorNos[i]} should guarantee.`);
    guarantors.push({ ...g, amount: guarantorAmts[i] });
  }
  if (principal > ownFree && guarantors.length < product.min_guarantors) {
    return fail(`This is more than your free deposits (${S.fmtKes(ownFree)}), so ${product.name} needs at least ${product.min_guarantors} guarantor(s).`);
  }
  if (!req.body.pledge) return fail('Please confirm the salary pledge and payslips.');

  const q = S.quote(product, principal, months);
  const loanId = await tx(async () => {
    const id = (await run(`INSERT INTO loans (member_id, product, principal, months, rate_monthly, method, installment, total_payable, fee, purpose, status, applied_at, topup_of)
                           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'guarantors', ?, ?)`,
      m.id, product.code, principal, months, product.rate_monthly, product.method, q.installment, q.total, q.fee,
      String(req.body.purpose || '').slice(0, 200), S.now(), topup ? topup.id : null)).lastInsertRowid;
    await logEvent(id, 'applied', 'Member', topup
      ? `Top-up of loan #${topup.id}: ${S.fmtKes(principal)} over ${months} months, clearing ${S.fmtKes(topup.clears)}`
      : `Applied for ${S.fmtKes(principal)} over ${months} months`);
    for (const g of guarantors) {
      await run(`INSERT INTO guarantees (loan_id, guarantor_id, amount, requested_at) VALUES (?, ?, ?, ?)`, id, g.id, g.amount, S.now());
    }
    await S.advanceIfCovered(id, logEvent);
    return id;
  });
  await audit(fullName(m), 'Loan application', 'loan', loanId, `${product.name} ${S.fmtKes(principal)}`);
  req.flash('success', guarantors.length ? 'Application sent. Your guarantors have been asked to accept.' : 'Application sent to the credit officer.');
  res.redirect('/portal/loans/' + loanId);
});

const SCHEDULE_STATUS = { paid: 'Paid', part: 'Part paid', overdue: 'Overdue', due: 'Upcoming', cleared: 'Cleared' };

// One of the member's own loans, with its repayment position and schedule (each installment marked paid, part paid, overdue or upcoming).
async function myLoan(req) {
  const loan = await one(`SELECT l.*, p.name AS product_name FROM loans l JOIN loan_products p ON p.code = l.product WHERE l.id = ? AND l.member_id = ?`,
    Number(req.params.id) || 0, req.member.id);
  if (!loan) return null;
  loan.state = await S.loanState(loan);
  const schedule = S.schedule(loan.principal, loan.months, loan.rate_monthly, loan.method, loan.disbursed_at);
  let paid = loan.state.paid;
  for (const row of schedule) { row.status = paid >= row.installment ? 'paid' : paid > 0 ? 'part' : (row.due && row.due < S.today() ? 'overdue' : 'due'); paid -= row.installment; }
  // A closed loan owes nothing more, even if a top-up cleared it early (no future interest).
  if (loan.status === 'closed') for (const row of schedule) if (row.status !== 'paid') row.status = 'cleared';
  return { loan, schedule };
}

router.get('/loans/:id', async (req, res, next) => {
  const found = await myLoan(req);
  if (!found) return next();
  const { loan, schedule } = found;
  const guarantors = await all(`SELECT g.*, m.first_name || ' ' || m.last_name AS name, m.member_no FROM guarantees g
                                JOIN members m ON m.id = g.guarantor_id WHERE g.loan_id = ?`, loan.id);
  const events = await all('SELECT * FROM loan_events WHERE loan_id = ? ORDER BY created_at, id', loan.id);
  const repayments = await all(`SELECT * FROM transactions WHERE loan_id = ? AND account = 'loan' ORDER BY created_at DESC`, loan.id);
  const canTopUp = loan.status === 'disbursed' && !loan.state.arrears;
  res.render('portal/loan', { title: loan.product_name, loan, guarantors, events, repayments, schedule, canTopUp, SCHEDULE_STATUS });
});

// Loan statement: ?format=csv for Excel, otherwise a printable page (Print / Save as PDF).
router.get('/loans/:id/statement', async (req, res, next) => {
  const found = await myLoan(req);
  if (!found || !['disbursed', 'closed'].includes(found.loan.status)) return next();
  const { loan, schedule } = found;
  if (req.query.format === 'csv') {
    return sendCsv(res, `deseret-sacco_${req.member.member_no}_loan-${loan.id}_schedule.csv`,
      ['Installment', 'Due date', 'Principal', 'Interest', 'Installment amount', 'Balance after', 'Status'],
      schedule.map(r => [r.no, r.due, r.principal, r.interest, r.installment, r.balance, SCHEDULE_STATUS[r.status]]));
  }
  let running = loan.total_payable;
  const repayments = (await all(`SELECT * FROM transactions WHERE loan_id = ? AND account = 'loan' ORDER BY created_at, id`, loan.id))
    .map(t => ({ ...t, balance: (running -= t.amount) }));
  if (loan.status === 'closed' && repayments.length) repayments[repayments.length - 1].balance = 0;
  res.render('portal/loan-statement', { loan, schedule, repayments, SCHEDULE_STATUS, clears: loan.status === 'disbursed' ? S.payoff(loan, loan.state.paid) : 0 });
});

router.get('/guarantees', async (req, res) => {
  const m = req.member;
  const requests = await all(`SELECT g.*, l.principal, l.months, l.installment, l.purpose, l.product, p.name AS product_name, b.id AS borrower_id,
                              b.first_name || ' ' || b.last_name AS borrower, b.member_no, b.joined_at
                              FROM guarantees g JOIN loans l ON l.id = g.loan_id JOIN loan_products p ON p.code = l.product JOIN members b ON b.id = l.member_id
                              WHERE g.guarantor_id = ? AND g.status = 'pending' AND l.status = 'guarantors' ORDER BY g.requested_at`, m.id);
  for (const r of requests) {
    const history = await S.memberLoans(r.borrower_id, ['disbursed', 'closed']);
    r.history = {
      closed: history.filter(l => l.status === 'closed').length,
      active: history.filter(l => l.status === 'disbursed').length,
      inArrears: history.some(l => l.state.arrears > 0),
      worstDays: Math.max(0, ...history.map(l => l.state.daysInArrears)),
    };
    r.cover = await all(`SELECT g.amount, g.status FROM guarantees g WHERE g.loan_id = ?`, r.loan_id);
  }
  const capacity = await S.guarantorCapacity(m.id);
  const guaranteed = await guaranteedLoans(m.id);
  const past = await all(`SELECT g.*, l.status AS loan_status, b.first_name || ' ' || b.last_name AS borrower, p.name AS product_name
                          FROM guarantees g JOIN loans l ON l.id = g.loan_id JOIN members b ON b.id = l.member_id JOIN loan_products p ON p.code = l.product
                          WHERE g.guarantor_id = ? AND (g.status = 'declined' OR l.status IN ('closed','rejected')) ORDER BY g.requested_at DESC`, m.id);
  res.render('portal/guarantees', { title: 'Guarantees', requests, capacity, guaranteed, past });
});

router.post('/guarantees/:id', async (req, res) => {
  const g = await one(`SELECT g.*, l.status AS loan_status FROM guarantees g JOIN loans l ON l.id = g.loan_id
                       WHERE g.id = ? AND g.guarantor_id = ? AND g.status = 'pending'`, Number(req.params.id) || 0, req.member.id);
  if (!g || g.loan_status !== 'guarantors') return res.redirect('/portal/guarantees');
  const accept = req.body.decision === 'accept';
  if (accept) {
    if (req.member.official_role) {
      req.flash('danger', 'As a SACCO official you can’t guarantee loans (By-law 69). Please decline so the borrower can ask someone else.');
      return res.redirect('/portal/guarantees');
    }
    const cap = await S.guarantorCapacity(req.member.id);
    if (g.amount > cap.free) {
      req.flash('danger', `You only have ${S.fmtKes(cap.free)} free to guarantee.`);
      return res.redirect('/portal/guarantees');
    }
    if (cap.count >= cap.maxLoans) {
      req.flash('danger', `You are already guaranteeing ${cap.count} loans. The limit is ${cap.maxLoans}.`);
      return res.redirect('/portal/guarantees');
    }
  }
  await tx(async () => {
    await run(`UPDATE guarantees SET status = ?, responded_at = ? WHERE id = ?`, accept ? 'accepted' : 'declined', S.now(), g.id);
    await logEvent(g.loan_id, accept ? 'guarantor accepted' : 'guarantor declined', fullName(req.member), `${S.fmtKes(g.amount)}`);
    if (accept) await S.advanceIfCovered(g.loan_id, logEvent);
  });
  await audit(fullName(req.member), accept ? 'Accepted guarantee' : 'Declined guarantee', 'loan', g.loan_id, S.fmtKes(g.amount));
  req.flash('success', accept ? `You are now guaranteeing ${S.fmtKes(g.amount)}.` : 'Request declined. The borrower will need another guarantor.');
  res.redirect('/portal/guarantees');
});

router.get('/profile', async (req, res) => {
  const nominees = await all('SELECT * FROM nominees WHERE member_id = ? ORDER BY share_pct DESC, id', req.member.id);
  const requests = await all(`SELECT * FROM requests WHERE member_id = ? AND type = 'deduction_change' ORDER BY created_at DESC LIMIT 5`, req.member.id);
  const nomineeRequest = await one(`SELECT * FROM requests WHERE member_id = ? AND type = 'nominee_change' ORDER BY created_at DESC LIMIT 1`, req.member.id);
  if (nomineeRequest) nomineeRequest.d = JSON.parse(nomineeRequest.details);
  const refundDue = req.member.exit_notice_at ? S.fmtDate(new Date(new Date(req.member.exit_notice_at).getTime() + setting('exit_notice_days') * 86400000).toISOString()) : null;
  res.render('portal/profile', { title: 'Profile', nominees, requests, nomineeRequest, edit: String(req.query.edit || ''), refundDue, noticeDays: setting('exit_notice_days') });
});

router.post('/profile/contact', async (req, res) => {
  const phone = String(req.body.phone || '').replace(/\s/g, '');
  if (!/^0[17]\d{8}$/.test(phone)) {
    req.flash('danger', 'Enter a Kenyan mobile number like 0712345678.');
    return res.redirect('/portal/profile?edit=contact#contact');
  }
  const email = String(req.body.email || '').trim().slice(0, 200);
  if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    req.flash('danger', 'Enter a valid email address or leave it empty.');
    return res.redirect('/portal/profile?edit=contact#contact');
  }
  await run('UPDATE members SET phone = ?, email = ? WHERE id = ?', phone, email, req.member.id);
  await audit(fullName(req.member), 'Updated contact details', 'member', req.member.id, `${phone} ${email}`);
  req.flash('success', `Contact details saved. We’ll now use ${phone}${email ? ' and ' + email : ''} to reach you. M-Pesa payments should come from ${phone}.`);
  res.redirect('/portal/profile#contact');
});

// By-law 12: a nomination must be in writing and witnessed by two members. Saving sends a request;
// the current nominees stay in force until the office confirms the change with the witnesses.
router.post('/profile/nominees', async (req, res) => {
  const pick = (k, i) => String([].concat(req.body[k])[i] || '').trim().slice(0, 120);
  const rows = [].concat(req.body.name || []).map((name, i) => ({
    name: String(name).trim().slice(0, 120), relationship: pick('relationship', i), phone: pick('phone', i),
    id_number: pick('id_number', i), address: pick('address', i), share_pct: parseInt([].concat(req.body.share_pct)[i], 10) || 0,
  })).filter(n => n.name);
  const total = rows.reduce((s, n) => s + n.share_pct, 0);
  const witnessNos = [req.body.witness1, req.body.witness2].map(w => String(w || '').trim().toUpperCase());
  const back = msg => { req.flash('danger', msg); return res.redirect('/portal/profile?edit=nominees#nominees'); };
  if (!rows.length) return back('Add at least one nominee.');
  if (rows.some(n => !n.relationship)) return back('Enter the relationship for each nominee.');
  if (total !== 100) return back(`Nominee shares must add up to 100% (they add up to ${total}%).`);
  const witnesses = [];
  for (const no of witnessNos) {
    const w = no && await one(`SELECT member_no, first_name, last_name FROM members WHERE member_no = ? AND status = 'active'`, no);
    if (!w) return back(`${no || 'Each witness'} must be an active member number.`);
    if (w.member_no === req.member.member_no) return back('You can’t witness your own nomination.');
    witnesses.push({ member_no: w.member_no, name: `${w.first_name} ${w.last_name}` });
  }
  if (witnesses[0].member_no === witnesses[1].member_no) return back('Choose two different witnesses.');
  const previous = await all('SELECT name, relationship, share_pct FROM nominees WHERE member_id = ?', req.member.id);
  await tx(async () => {
    // Only one change waits at a time; a new one replaces any earlier pending request.
    await run(`DELETE FROM requests WHERE member_id = ? AND type = 'nominee_change' AND status = 'pending'`, req.member.id);
    await run(`INSERT INTO requests (member_id, type, details, created_at) VALUES (?, 'nominee_change', ?, ?)`,
      req.member.id, JSON.stringify({ nominees: rows, witnesses, previous }), S.now());
  });
  await audit(fullName(req.member), 'Requested nominee change', 'member', req.member.id, rows.map(n => `${n.name} ${n.share_pct}%`).join(', '));
  req.flash('success', `Your nominee change has been sent to the office. Until it is confirmed with your witnesses (${witnesses.map(w => w.name).join(' and ')}), your current nominees stay on file.`);
  res.redirect('/portal/profile#nominees');
});

router.post('/profile/nominees/cancel', async (req, res) => {
  const { changes } = await run(`DELETE FROM requests WHERE member_id = ? AND type = 'nominee_change' AND status = 'pending'`, req.member.id);
  if (changes) await audit(fullName(req.member), 'Cancelled nominee change', 'member', req.member.id);
  req.flash('success', 'Nominee change cancelled. Your current nominees are unchanged.');
  res.redirect('/portal/profile#nominees');
});

router.post('/profile/password', async (req, res) => {
  const { current, next: fresh, confirm } = req.body;
  if (!checkPassword(String(current || ''), req.member.password_hash)) req.flash('danger', 'Your current password is wrong.');
  else if (String(fresh || '').length < 8) req.flash('danger', 'Use at least 8 characters for the new password.');
  else if (fresh !== confirm) req.flash('danger', 'The new passwords don’t match.');
  else {
    await run('UPDATE members SET password_hash = ? WHERE id = ?', hashPassword(fresh), req.member.id);
    await audit(fullName(req.member), 'Changed password', 'member', req.member.id);
    req.flash('success', 'Password changed.');
  }
  res.redirect('/portal/profile');
});

router.post('/profile/exit', async (req, res) => {
  const m = req.member;
  if (m.status !== 'active') return res.redirect('/portal/profile');
  // By-law 64(XXII): loans must be cleared and guarantees released before withdrawing.
  if ((await S.memberLoans(m.id)).length) {
    req.flash('danger', 'You can give notice once your loans are cleared.');
    return res.redirect('/portal/profile');
  }
  if ((await S.guarantorCapacity(m.id)).count) {
    req.flash('danger', 'You are still guaranteeing other members’ loans. They need replacement guarantors before you can leave.');
    return res.redirect('/portal/profile');
  }
  await run(`UPDATE members SET status = 'exiting', exit_notice_at = ? WHERE id = ?`, S.today(), m.id);
  await audit(fullName(m), 'Gave exit notice', 'member', m.id);
  req.flash('success', 'Your notice has been received. We’ll contact you about any loans you guarantee.');
  res.redirect('/portal/profile');
});

// Live calculator and guarantor lookup used by the application form.
router.get('/api/quote', async (req, res) => {
  const product = await one('SELECT * FROM loan_products WHERE code = ?', String(req.query.product || ''));
  const amount = parseInt(req.query.amount, 10), months = parseInt(req.query.months, 10);
  if (!product || !(amount > 0) || !(months > 0)) return res.json({});
  res.json(S.quote(product, amount, Math.min(months, product.max_months)));
});

router.get('/api/member/:no', async (req, res) => {
  const g = await one(`SELECT id, first_name, last_name, official_role FROM members WHERE member_no = ? AND status = 'active'`, req.params.no.toUpperCase());
  if (!g || g.id === req.member.id) return res.json({ found: false });
  res.json({ found: true, name: `${g.first_name} ${g.last_name}`, official: !!g.official_role });
});

module.exports = router;
