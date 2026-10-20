// Fills the database with fictional demo data. Run `npm run seed` to reset.
// All rates and rules below are SAMPLE values until replaced with the by-law figures.
const fs = require('fs');
const path = require('path');

if (require.main === module) {
  const file = path.join(__dirname, 'data', 'sacco.db');
  for (const f of [file, file + '-wal', file + '-shm']) fs.rmSync(f, { force: true });
}

const { one, run, tx, all } = require('./db');
const { hashPassword } = require('./lib/auth');
const S = require('./lib/sacco');

function seed() {
  let r = 42;
  const rand = () => { r = (r * 1103515245 + 12345) % 2147483648; return r / 2147483648; };
  const pick = arr => arr[Math.floor(rand() * arr.length)];
  const between = (a, b) => Math.floor(a + rand() * (b - a + 1));
  const code = () => Array.from({ length: 10 }, () => 'ABCDEFGHJKLMNPQRSTUVWXYZ0123456789'[between(0, 33)]).join('');
  const T = S.today();
  const daysAgo = n => new Date(Date.now() - n * 86400000).toISOString().slice(0, 10);
  const password = hashPassword('demo1234');

  // Values marked BL come from the registered by-laws (2006, as amended). Others are placeholders to confirm.
  const settings = [
    ['entry_fee', 1000, 'Entry fee, KES (BL9)'],
    ['min_share_capital', 6500, 'Minimum share capital, KES — 325 shares × 20 (BL9)'],
    ['share_value', 20, 'Value of one share, KES (BL9)'],
    ['min_monthly_deposit', 1000, 'Minimum monthly deposit, KES (website — not in by-laws)'],
    ['min_membership_months', 6, 'Months of membership before a loan (BL64 I)'],
    ['min_take_home_pct', 33.33, 'Minimum take-home after all deductions incl. savings, % of basic pay (BL64 XII)'],
    ['max_loans_guaranteed', 3, 'Maximum loans one member may guarantee (BL64 XIX, BL68)'],
    ['max_loan_pct_capital', 5, 'Largest single loan, % of society share capital & reserves (BL64 VI, BL76)'],
    ['exit_notice_days', 60, 'Withdrawal notice, days (BL16, BL24)'],
    ['default_after_months', 3, 'Missed months before a loan is declared in default (BL64 XXVI)'],
    ['deposit_interest_pct', 8, 'Interest on deposits, last AGM % (placeholder — set by AGM, BL27)'],
    ['dividend_pct', 10, 'Dividend on shares, last AGM % (placeholder — set by AGM, BL63)'],
  ];
  for (const [k, v, label] of settings) run('INSERT INTO settings (key, value, label) VALUES (?, ?, ?)', k, String(v), label);

  const products = [
    ['emergency', 'Emergency Loan', 'Hospital bills, funerals or court fines (not rent). Repaid within 12 months.', 0.01, 'reducing', 12, 3, 1, 1, null],
    ['development', 'Development Loan', 'The normal loan: land, building, business or other investment. Up to 48 months.', 0.01, 'reducing', 48, 3, 2, 1, null],
    ['school', 'School Fees Loan', 'Fees paid by cheque straight to the school. One per calendar year, repaid within 12 months.', 0.01, 'reducing', 12, 4, 1, 1, null],
    ['vacation', 'Vacation Loan', 'Plan a holiday or family trip.', 0.012, 'reducing', 12, 3, 2, 1, null],
    ['salary', 'Salary Advance', 'Short-term advance against your next salaries.', 0.02, 'flat', 3, 3, 0, 2, 50],
  ];
  for (const p of products) {
    run(`INSERT INTO loan_products (code, name, description, rate_monthly, method, max_months, multiplier, min_guarantors, fee_pct, max_salary_pct)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`, ...p);
  }
  const product = c => one('SELECT * FROM loan_products WHERE code = ?', c);

  const staff = [
    ['Mary Atieno', 'clerk@deseret.demo', 'clerk'],
    ['Peter Kamau', 'credit@deseret.demo', 'credit'],
    ['Joyce Mwangi', 'manager@deseret.demo', 'manager'],
    ['David Otieno', 'treasurer@deseret.demo', 'treasurer'],
    ['Board Viewer', 'board@deseret.demo', 'board'],
  ];
  for (const [name, email, role] of staff) run('INSERT INTO staff (name, email, role, password_hash) VALUES (?, ?, ?, ?)', name, email, role, password);
  const [clerk, credit, manager, treasurer] = [1, 2, 3, 4];

  const first = ['Grace', 'John', 'Faith', 'Samuel', 'Mercy', 'Joseph', 'Esther', 'Daniel', 'Ruth', 'Brian', 'Lucy', 'Kevin', 'Agnes', 'Moses', 'Naomi',
    'Peter', 'Janet', 'Stephen', 'Caroline', 'Isaac', 'Winnie', 'George', 'Beatrice', 'Collins', 'Alice', 'Victor', 'Purity', 'Dennis', 'Rose', 'Elijah'];
  const last = ['Wanjiru', 'Ochieng', 'Muthoni', 'Kiprono', 'Achieng', 'Mutua', 'Wambui', 'Kariuki', 'Nekesa', 'Otieno', 'Chebet', 'Njoroge', 'Akinyi',
    'Kimani', 'Wairimu', 'Odhiambo', 'Jepkemoi', 'Mwangi', 'Nyambura', 'Barasa', 'Moraa', 'Omondi', 'Kerubo', 'Kipchumba', 'Njeri', 'Owino', 'Waithera', 'Ruto', 'Atieno', 'Kilonzo'];
  const departments = ['Area Office', 'Church Educational System', 'Welfare & Self-Reliance', 'Facilities Management', 'Family History', 'Seminaries & Institutes', 'Temple'];

  const members = [];
  for (let i = 0; i < 30; i++) {
    const joined = S.addMonths(T, -(i === 0 ? 40 : i === 5 ? 3 : between(9, 60)));
    const terms = i === 12 ? 'contract' : [22, 26].includes(i) ? 'not employed' : 'permanent';
    const id = run(`INSERT INTO members (member_no, first_name, last_name, id_number, kra_pin, phone, email, date_of_birth, address, employer, department, designation,
        terms, contract_end, payroll_no, ward, bank_name, bank_branch, bank_account, net_salary, status, joined_at, admission_minute, password_hash, created_by, approved_by, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'active', ?, ?, ?, ?, ?, ?)`,
      'DS' + String(i + 1).padStart(4, '0'), first[i], last[i], String(between(20000000, 39999999)),
      'A00' + between(1000000, 9999999) + pick('ABCDEFGH'), '07' + between(10000000, 99999999),
      `${first[i]}.${last[i]}@example.com`.toLowerCase(), `${between(1965, 2000)}-0${between(1, 9)}-1${between(0, 9)}`,
      'P.O. Box ' + between(1000, 99999) + ', Nairobi',
      terms === 'not employed' ? null : 'The Church of Jesus Christ of Latter-day Saints', terms === 'not employed' ? null : pick(departments),
      terms === 'not employed' ? null : pick(['Officer', 'Coordinator', 'Accountant', 'Administrator', 'Driver', 'Technician', 'Manager']),
      terms, terms === 'contract' ? S.addMonths(T, 14) : null, terms === 'not employed' ? null : 'P' + between(10000, 99999),
      pick(['Upper Hill Ward', 'Kibera Ward', 'Kasarani Ward', 'Thika Road Ward', 'Ngong Ward', 'Ruiru Ward', 'Embakasi Ward']),
      pick(['Co-operative Bank', 'Equity Bank', 'KCB', 'NCBA']), pick(['Ngong Road', 'Upper Hill', 'Westlands', 'Moi Avenue']), '01' + between(100000000, 999999999),
      i === 0 ? 92000 : between(4, 16) * 10000, joined, 'MC/' + joined.slice(0, 4) + '/' + between(10, 99), password, clerk, manager, joined + ' 09:00:00').lastInsertRowid;
    members.push({ id, joined, terms, monthly: i === 0 ? 12000 : between(3, 15) * 1000, holiday: rand() < 0.35 || i === 0, family: rand() < 0.25 || i === 0, lateMonths: { 3: 3, 11: 1 }[i] || 0 });
  }
  const grace = members[0];

  run(`INSERT INTO nominees (member_id, name, relationship, id_number, phone, address, share_pct) VALUES (?, 'James Kamau Wanjiru', 'Spouse', '23456781', '0722123456', 'P.O. Box 1234, Nairobi', 60)`, grace.id);
  run(`INSERT INTO nominees (member_id, name, relationship, id_number, phone, address, share_pct) VALUES (?, 'Amani Wanjiru', 'Daughter', '', '0711987654', 'P.O. Box 1234, Nairobi', 40)`, grace.id);
  run(`INSERT INTO goals (member_id, account, target, target_date) VALUES (?, 'holiday', 120000, ?)`, grace.id, S.addMonths(T, 5));
  run(`INSERT INTO goals (member_id, account, target, target_date) VALUES (?, 'family', 200000, ?)`, grace.id, S.addMonths(T, 18));

  const event = (loanId, step, actor, note, at) => run('INSERT INTO loan_events (loan_id, step, actor, note, created_at) VALUES (?, ?, ?, ?, ?)', loanId, step, actor, note, at);
  const staffName = id => one('SELECT name FROM staff WHERE id = ?', id).name;

  function createLoan(m, code, principal, months, appliedAt, status, guarantors = []) {
    const p = product(code);
    const q = S.quote(p, principal, months);
    const disbursedAt = status === 'disbursed' || status === 'closed' ? S.addMonths(appliedAt, 0).slice(0, 10) : null;
    const id = run(`INSERT INTO loans (member_id, product, principal, months, rate_monthly, method, installment, total_payable, fee, purpose, status, applied_at,
                    recommended_by, approved_by, disbursed_by, disbursed_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      m.id, code, principal, months, p.rate_monthly, p.method, q.installment, q.total, q.fee,
      pick(['Plot purchase', 'Medical bills', 'Construction', 'Tuition', 'Family trip', 'Car repair', 'Business stock']), status, appliedAt + ' 10:00:00',
      ['recommended', 'approved', 'disbursed', 'closed'].includes(status) ? credit : null,
      ['approved', 'disbursed', 'closed'].includes(status) ? manager : null,
      disbursedAt ? treasurer : null, disbursedAt).lastInsertRowid;
    event(id, 'applied', 'Member', `Applied for ${S.fmtKes(principal)} over ${months} months`, appliedAt + ' 10:00:00');
    for (const [g, amount, gStatus] of guarantors) {
      run(`INSERT INTO guarantees (loan_id, guarantor_id, amount, status, requested_at, responded_at) VALUES (?, ?, ?, ?, ?, ?)`,
        id, g.id, amount, gStatus, appliedAt + ' 10:05:00', gStatus === 'pending' ? null : appliedAt + ' 15:00:00');
    }
    const steps = ['appraisal', 'recommended', 'approved', 'disbursed'];
    const reached = status === 'closed' ? 4 : steps.indexOf(status) + 1;
    const notes = {
      appraisal: ['System', 'Guarantors complete — sent to credit officer'],
      recommended: [staffName(credit), 'Appraisal passed. Recommended for approval.'],
      approved: [staffName(manager), 'Approved'],
      disbursed: [staffName(treasurer), 'Funds sent to member’s bank account'],
    };
    steps.slice(0, reached).forEach((s, i) => event(id, s, notes[s][0], notes[s][1], appliedAt + ` 1${i + 1}:00:00`));
    return { id, ...q, months, disbursedAt, status };
  }

  // Disbursed loans whose repayments are included in the monthly payments below.
  const loanPlans = new Map();
  const disbursed = [
    [0, 'development', 300000, 36, -14, [[1, 100000], [2, 100000]]],
    [3, 'school', 80000, 12, -7, [[0, 40000], [4, 40000]]],
    [7, 'development', 450000, 48, -20, [[6, 80000], [8, 120000], [9, 100000]]],
    [11, 'emergency', 40000, 12, -6, [[12, 20000]]],
    [14, 'vacation', 60000, 12, -4, [[0, 30000], [15, 30000]]],
    [18, 'development', 250000, 36, -10, [[17, 50000], [19, 80000], [20, 60000]]],
    [21, 'school', 90000, 12, -3, [[22, 45000], [23, 45000]]],
    [25, 'emergency', 30000, 6, -9, [[26, 15000]]],
  ];
  for (const [mi, code, principal, months, offset, gs] of disbursed) {
    const m = members[mi];
    // Borrowers must have been members for a while before their loan started.
    if (m.joined > S.addMonths(T, offset - 8)) {
      m.joined = S.addMonths(T, offset - 14);
      run('UPDATE members SET joined_at = ?, created_at = ? WHERE id = ?', m.joined, m.joined + ' 09:00:00', m.id);
    }
    const loan = createLoan(m, code, principal, months, S.addMonths(T, offset), 'disbursed', gs.map(([gi, amt]) => [members[gi], amt, 'accepted']));
    loanPlans.set(m.id, [...(loanPlans.get(m.id) || []), loan]);
  }

  // Monthly contributions from joining to now, split across accounts and loans.
  const channels = ['mpesa', 'mpesa', 'mpesa', 'bank', 'checkoff'];
  for (const m of members) {
    let shares = 0;
    const loans = loanPlans.get(m.id) || [];
    for (let k = 0; S.addMonths(m.joined, k) <= T; k++) {
      const day = S.addMonths(m.joined, k);
      const skip = m.lateMonths && S.addMonths(day, m.lateMonths) > T;
      const parts = [];
      if (shares < 6500) { const s = Math.min(k === 0 ? 2500 : 500, 6500 - shares); parts.push(['shares', s, 'Share capital']); shares += s; }
      if (m.holiday) parts.push(['holiday', m.id === grace.id ? 3000 : 2000, 'Holiday savings']);
      if (m.family) parts.push(['family', m.id === grace.id ? 3000 : 1500, 'Family savings']);
      parts.push(['deposits', m.monthly, 'Monthly deposit']);
      for (const loan of loans) {
        if (day > loan.disbursedAt && !skip) {
          const paid = one(`SELECT COALESCE(SUM(amount), 0) AS p FROM transactions WHERE loan_id = ?`, loan.id).p;
          const due = Math.min(loan.installment, loan.total - paid);
          if (due > 0) parts.push(['loan', due, 'Loan repayment', loan.id]);
        }
      }
      if (skip) { parts.length = 0; }
      if (!parts.length) continue;
      const total = parts.reduce((s, p) => s + p[1], 0);
      const channel = m.terms === 'not employed' ? pick(['standing', 'mpesa']) : pick(channels);
      const at = day + ` 0${between(7, 9)}:${between(10, 59)}:00`;
      const pid = run(`INSERT INTO payments (member_id, amount, channel, reference, status, created_by, approved_by, created_at) VALUES (?, ?, ?, ?, 'posted', ?, ?, ?)`,
        m.id, total, channel, channel === 'mpesa' ? code() : channel === 'bank' ? 'EQ' + between(100000, 999999) : channel === 'standing' ? 'SO-' + day.slice(0, 7) : 'CHK-' + day.slice(0, 7),
        channel === 'mpesa' ? null : clerk, channel === 'mpesa' ? null : manager, at).lastInsertRowid;
      for (const [account, amount, desc, loanId] of parts) {
        run('INSERT INTO transactions (member_id, payment_id, loan_id, account, amount, description, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
          m.id, pid, loanId || null, account, amount, desc, at);
      }
    }
  }

  // Grace made a holiday withdrawal last year — shows a debit in her statement.
  run(`INSERT INTO transactions (member_id, account, amount, description, created_at) VALUES (?, 'holiday', -45000, 'Holiday savings withdrawal', ?)`,
    grace.id, S.addMonths(T, -10) + ' 11:30:00');

  // Loans in the pipeline, so every admin queue has something in it.
  createLoan(members[1], 'school', 60000, 10, daysAgo(15), 'guarantors', [[grace, 30000, 'pending'], [members[2], 30000, 'accepted']]);
  createLoan(members[9], 'development', 200000, 36, daysAgo(9), 'appraisal', [[members[10], 70000, 'accepted'], [members[12], 70000, 'accepted'], [members[13], 60000, 'accepted']]);
  createLoan(members[16], 'emergency', 25000, 6, daysAgo(3), 'appraisal', [[members[17], 25000, 'accepted']]);
  createLoan(members[24], 'vacation', 50000, 12, daysAgo(12), 'recommended', [[members[26], 25000, 'accepted'], [members[27], 25000, 'accepted']]);
  createLoan(members[28], 'school', 70000, 12, daysAgo(18), 'approved', [[members[29], 35000, 'accepted'], [members[2], 35000, 'accepted']]);
  createLoan(members[4], 'development', 150000, 24, daysAgo(6), 'guarantors', [[members[6], 50000, 'accepted'], [members[8], 50000, 'pending'], [members[10], 50000, 'declined']]);

  // Grace's earlier loan, fully paid — shows history.
  const old = createLoan(grace, 'emergency', 30000, 6, S.addMonths(T, -30), 'closed', [[members[1], 30000, 'accepted']]);
  run(`UPDATE loans SET disbursed_at = ? WHERE id = ?`, S.addMonths(T, -30), old.id);
  run(`INSERT INTO transactions (member_id, loan_id, account, amount, description, created_at) VALUES (?, ?, 'loan', ?, 'Loan repayment (fully paid)', ?)`,
    grace.id, old.id, old.total, S.addMonths(T, -24) + ' 09:00:00');

  // Work waiting for the manager: new members and bank payments entered by the clerk.
  for (const [fn, ln] of [['Tabitha', 'Wekesa'], ['Emmanuel', 'Kibet']]) {
    run(`INSERT INTO members (first_name, last_name, id_number, kra_pin, phone, email, employer, department, payroll_no, net_salary, status, created_by, created_at)
         VALUES (?, ?, ?, ?, ?, ?, 'The Church of Jesus Christ of Latter-day Saints', 'Area Office', ?, ?, 'pending', ?, ?)`,
      fn, ln, String(between(30000000, 39999999)), 'A00' + between(1000000, 9999999) + 'K', '07' + between(10000000, 99999999),
      `${fn}.${ln}@example.com`.toLowerCase(), 'P' + between(10000, 99999), between(5, 9) * 10000, clerk, T + ' 08:40:00');
  }
  for (const mi of [5, 12, 20]) {
    const amt = between(3, 12) * 1000;
    run(`INSERT INTO payments (member_id, amount, channel, reference, status, created_by, note, created_at) VALUES (?, ?, 'bank', ?, 'pending', ?, ?, ?)`,
      members[mi].id, amt, 'EQ' + between(100000, 999999), clerk, JSON.stringify([{ account: 'deposits', amount: amt }]), T + ' 09:15:00');
  }

  // A member paid via the Co-op Bank Paybill and submitted the M-Pesa code for staff to verify.
  run(`INSERT INTO payments (member_id, amount, channel, reference, status, submitted_by_member, note, created_at) VALUES (?, 5000, 'mpesa', ?, 'pending', 1, ?, ?)`,
    members[7].id, code(), JSON.stringify([{ account: 'deposits', amount: 5000 }]), T + ' 07:52:00');

  // "Authority to vary deductions" request from a member.
  run(`INSERT INTO requests (member_id, type, details, created_at) VALUES (?, 'deduction_change', ?, ?)`, members[13].id,
    JSON.stringify({ shares_from: 3000, shares_to: 5000, loan_from: 0, loan_to: 0, effective: S.addMonths(T, 1).slice(0, 7) + '-01' }), T + ' 08:10:00');

  // One member has given notice to leave.
  run(`UPDATE members SET status = 'exiting', exit_notice_at = ? WHERE id = ?`, S.addMonths(T, -1), members[27].id);

  run(`INSERT INTO audit (actor, action, entity, details, created_at) VALUES ('System', 'Demo data loaded', 'system', 'Sample data — not real members', datetime('now'))`);
}

if (!one('SELECT 1 AS x FROM staff LIMIT 1')) tx(seed);
if (require.main === module) console.log('Demo data ready:', all('SELECT COUNT(*) AS n FROM members')[0].n, 'members');

module.exports = seed;
