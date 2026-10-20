// Fills the database with fictional demo data: `npm run seed` (wipes existing data first).
// Rows are built in memory and inserted in batches, so seeding a remote database stays quick.
const { all, run, tx, pool } = require('./db');
const { hashPassword } = require('./lib/auth');
const S = require('./lib/sacco');

const TABLES = ['login_attempts', 'contact_messages', 'audit', 'loan_events', 'transactions', 'guarantees', 'loans', 'payments', 'requests', 'goals', 'nominees', 'members', 'staff', 'loan_products', 'settings'];

// Multi-row INSERT in chunks; returns the new ids in input order.
async function insertMany(table, cols, rows) {
  const ids = [];
  for (let i = 0; i < rows.length; i += 400) {
    const chunk = rows.slice(i, i + 400);
    const values = chunk.map(() => `(${cols.map(() => '?').join(', ')})`).join(', ');
    const hasId = !['settings', 'loan_products', 'goals'].includes(table);
    const sql = `INSERT INTO ${table} (${cols.join(', ')}) VALUES ${values}${hasId ? ' RETURNING id' : ''}`;
    const result = hasId ? await all(sql, ...chunk.flat()) : (await run(sql + ' RETURNING 1', ...chunk.flat()), []);
    ids.push(...result.map(r => r.id));
  }
  return ids;
}

async function seed() {
  let r = 42;
  const rand = () => { r = (r * 1103515245 + 12345) % 2147483648; return r / 2147483648; };
  const pick = arr => arr[Math.floor(rand() * arr.length)];
  const between = (a, b) => Math.floor(a + rand() * (b - a + 1));
  const code = () => Array.from({ length: 10 }, () => 'ABCDEFGHJKLMNPQRSTUVWXYZ0123456789'[between(0, 33)]).join('');
  const T = S.today();
  const daysAgo = n => new Date(Date.now() - n * 86400000).toISOString().slice(0, 10);
  const password = hashPassword('demo1234');

  // Values marked BL come from the registered by-laws (2006, as amended). Others are placeholders to confirm.
  await insertMany('settings', ['key', 'value', 'label'], [
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
  ].map(([k, v, label]) => [k, String(v), label]));

  const productRows = [
    ['emergency', 'Emergency Loan', 'Hospital bills, funerals or court fines (not rent). Repaid within 12 months.', 0.01, 'reducing', 12, 3, 1, 1, null],
    ['development', 'Development Loan', 'The normal loan: land, building, business or other investment. Up to 48 months.', 0.01, 'reducing', 48, 3, 2, 1, null],
    ['school', 'School Fees Loan', 'Fees paid by cheque straight to the school. One per calendar year, repaid within 12 months.', 0.01, 'reducing', 12, 4, 1, 1, null],
    ['vacation', 'Vacation Loan', 'Plan a holiday or family trip.', 0.012, 'reducing', 12, 3, 2, 1, null],
    ['salary', 'Salary Advance', 'Short-term advance against your next salaries.', 0.02, 'flat', 3, 3, 0, 2, 50],
  ];
  await insertMany('loan_products', ['code', 'name', 'description', 'rate_monthly', 'method', 'max_months', 'multiplier', 'min_guarantors', 'fee_pct', 'max_salary_pct'], productRows);
  const product = Object.fromEntries(productRows.map(p => [p[0], { rate_monthly: p[3], method: p[4], fee_pct: p[8] }]));

  const staffRows = [
    ['Mary Atieno', 'clerk@deseret.demo', 'clerk'],
    ['Peter Kamau', 'credit@deseret.demo', 'credit'],
    ['Joyce Mwangi', 'manager@deseret.demo', 'manager'],
    ['David Otieno', 'treasurer@deseret.demo', 'treasurer'],
    ['Board Viewer', 'board@deseret.demo', 'board'],
  ];
  const [clerk, credit, manager, treasurer] = await insertMany('staff', ['name', 'email', 'role', 'password_hash'], staffRows.map(s => [...s, password]));
  const staffName = { [credit]: staffRows[1][0], [manager]: staffRows[2][0], [treasurer]: staffRows[3][0] };

  const first = ['Grace', 'John', 'Faith', 'Samuel', 'Mercy', 'Joseph', 'Esther', 'Daniel', 'Ruth', 'Brian', 'Lucy', 'Kevin', 'Agnes', 'Moses', 'Naomi',
    'Peter', 'Janet', 'Stephen', 'Caroline', 'Isaac', 'Winnie', 'George', 'Beatrice', 'Collins', 'Alice', 'Victor', 'Purity', 'Dennis', 'Rose', 'Elijah'];
  const last = ['Wanjiru', 'Ochieng', 'Muthoni', 'Kiprono', 'Achieng', 'Mutua', 'Wambui', 'Kariuki', 'Nekesa', 'Otieno', 'Chebet', 'Njoroge', 'Akinyi',
    'Kimani', 'Wairimu', 'Odhiambo', 'Jepkemoi', 'Mwangi', 'Nyambura', 'Barasa', 'Moraa', 'Omondi', 'Kerubo', 'Kipchumba', 'Njeri', 'Owino', 'Waithera', 'Ruto', 'Atieno', 'Kilonzo'];
  const departments = ['Area Office', 'Church Educational System', 'Welfare & Self-Reliance', 'Facilities Management', 'Family History', 'Seminaries & Institutes', 'Temple'];

  // Loans already paid out; their repayments are woven into the monthly payments below.
  // [member index, product, principal, months, months ago, [[guarantor index, amount]]]
  const disbursedPlans = [
    [0, 'development', 300000, 36, -14, [[1, 100000], [2, 100000]]],
    [3, 'school', 80000, 12, -7, [[0, 40000], [4, 40000]]],
    [7, 'development', 450000, 48, -20, [[6, 80000], [8, 120000], [9, 100000]]],
    [11, 'emergency', 40000, 12, -6, [[12, 20000]]],
    [14, 'vacation', 60000, 12, -4, [[0, 30000], [15, 30000]]],
    [18, 'development', 250000, 36, -10, [[17, 50000], [19, 80000], [20, 60000]]],
    [21, 'school', 90000, 12, -3, [[22, 45000], [23, 45000]]],
    [25, 'emergency', 30000, 6, -9, [[26, 15000]]],
  ];

  const members = [];
  const memberRows = [];
  for (let i = 0; i < 30; i++) {
    let joined = S.addMonths(T, -(i === 0 ? 40 : i === 5 ? 3 : between(9, 60)));
    // Borrowers must have been members for a while before their loan started.
    const plan = disbursedPlans.find(p => p[0] === i);
    if (plan && joined > S.addMonths(T, plan[4] - 8)) joined = S.addMonths(T, plan[4] - 14);
    const terms = i === 12 ? 'contract' : [22, 26].includes(i) ? 'not employed' : 'permanent';
    memberRows.push(['DS' + String(i + 1).padStart(4, '0'), first[i], last[i], String(between(20000000, 39999999)),
      'A00' + between(1000000, 9999999) + pick('ABCDEFGH'), '07' + between(10000000, 99999999),
      `${first[i]}.${last[i]}@example.com`.toLowerCase(), `${between(1965, 2000)}-0${between(1, 9)}-1${between(0, 9)}`,
      'P.O. Box ' + between(1000, 99999) + ', Nairobi',
      terms === 'not employed' ? null : 'The Church of Jesus Christ of Latter-day Saints', terms === 'not employed' ? null : pick(departments),
      terms === 'not employed' ? null : pick(['Officer', 'Coordinator', 'Accountant', 'Administrator', 'Driver', 'Technician', 'Manager']),
      terms, terms === 'contract' ? S.addMonths(T, 14) : null, terms === 'not employed' ? null : 'P' + between(10000, 99999),
      pick(['Upper Hill Ward', 'Kibera Ward', 'Kasarani Ward', 'Thika Road Ward', 'Ngong Ward', 'Ruiru Ward', 'Embakasi Ward']),
      pick(['Co-operative Bank', 'Equity Bank', 'KCB', 'NCBA']), pick(['Ngong Road', 'Upper Hill', 'Westlands', 'Moi Avenue']), '01' + between(100000000, 999999999),
      i === 0 ? 92000 : between(4, 16) * 10000, 'active', joined, 'MC/' + joined.slice(0, 4) + '/' + between(10, 99), password, clerk, manager, joined + ' 09:00:00']);
    members.push({ joined, terms, monthly: i === 0 ? 12000 : between(3, 15) * 1000, holiday: rand() < 0.35 || i === 0, family: rand() < 0.25 || i === 0, lateMonths: { 3: 3, 11: 1 }[i] || 0 });
  }
  const memberIds = await insertMany('members', ['member_no', 'first_name', 'last_name', 'id_number', 'kra_pin', 'phone', 'email', 'date_of_birth', 'address',
    'employer', 'department', 'designation', 'terms', 'contract_end', 'payroll_no', 'ward', 'bank_name', 'bank_branch', 'bank_account',
    'net_salary', 'status', 'joined_at', 'admission_minute', 'password_hash', 'created_by', 'approved_by', 'created_at'], memberRows);
  memberIds.forEach((id, i) => { members[i].id = id; });
  const grace = members[0];

  await insertMany('nominees', ['member_id', 'name', 'relationship', 'id_number', 'phone', 'address', 'share_pct'], [
    [grace.id, 'James Kamau Wanjiru', 'Spouse', '23456781', '0722123456', 'P.O. Box 1234, Nairobi', 60],
    [grace.id, 'Amani Wanjiru', 'Daughter', '', '0711987654', 'P.O. Box 1234, Nairobi', 40],
  ]);
  await insertMany('goals', ['member_id', 'account', 'target', 'target_date'], [
    [grace.id, 'holiday', 120000, S.addMonths(T, 5)],
    [grace.id, 'family', 200000, S.addMonths(T, 18)],
  ]);

  // Loans: build rows, insert, then add their guarantees and timeline events.
  const purposes = ['Plot purchase', 'Medical bills', 'Construction', 'Tuition', 'Family trip', 'Car repair', 'Business stock'];
  const loanSpecs = [];
  const addLoan = (m, code, principal, months, appliedAt, status, guarantors = []) => {
    const q = S.quote(product[code], principal, months);
    const disbursedAt = ['disbursed', 'closed'].includes(status) ? appliedAt : null;
    const spec = { m, code, principal, months, appliedAt, status, guarantors, ...q, disbursedAt, paid: 0 };
    loanSpecs.push(spec);
    return spec;
  };
  const plans = new Map();
  for (const [mi, code, principal, months, offset, gs] of disbursedPlans) {
    const spec = addLoan(members[mi], code, principal, months, S.addMonths(T, offset), 'disbursed', gs.map(([gi, amt]) => [members[gi], amt, 'accepted']));
    plans.set(members[mi].id, [...(plans.get(members[mi].id) || []), spec]);
  }
  // Applications in the pipeline, so every admin queue has something in it.
  addLoan(members[1], 'school', 60000, 10, daysAgo(15), 'guarantors', [[grace, 30000, 'pending'], [members[2], 30000, 'accepted']]);
  addLoan(members[9], 'development', 200000, 36, daysAgo(9), 'appraisal', [[members[10], 70000, 'accepted'], [members[12], 70000, 'accepted'], [members[13], 60000, 'accepted']]);
  addLoan(members[16], 'emergency', 25000, 6, daysAgo(3), 'appraisal', [[members[17], 25000, 'accepted']]);
  addLoan(members[24], 'vacation', 50000, 12, daysAgo(12), 'recommended', [[members[26], 25000, 'accepted'], [members[27], 25000, 'accepted']]);
  addLoan(members[28], 'school', 70000, 12, daysAgo(18), 'approved', [[members[29], 35000, 'accepted'], [members[2], 35000, 'accepted']]);
  addLoan(members[4], 'development', 150000, 24, daysAgo(6), 'guarantors', [[members[6], 50000, 'accepted'], [members[8], 50000, 'pending'], [members[10], 50000, 'declined']]);
  // Grace's earlier loan, fully paid — shows history.
  const old = addLoan(grace, 'emergency', 30000, 6, S.addMonths(T, -30), 'closed', [[members[1], 30000, 'accepted']]);

  const loanIds = await insertMany('loans', ['member_id', 'product', 'principal', 'months', 'rate_monthly', 'method', 'installment', 'total_payable', 'fee',
    'purpose', 'status', 'applied_at', 'recommended_by', 'approved_by', 'disbursed_by', 'disbursed_at'],
  loanSpecs.map(l => [l.m.id, l.code, l.principal, l.months, product[l.code].rate_monthly, product[l.code].method, l.installment, l.total, l.fee,
    pick(purposes), l.status, l.appliedAt + ' 10:00:00',
    ['recommended', 'approved', 'disbursed', 'closed'].includes(l.status) ? credit : null,
    ['approved', 'disbursed', 'closed'].includes(l.status) ? manager : null,
    l.disbursedAt ? treasurer : null, l.disbursedAt]));
  loanIds.forEach((id, i) => { loanSpecs[i].id = id; });

  const guaranteeRows = [];
  const eventRows = [];
  const notes = {
    appraisal: ['System', 'Guarantors complete — sent to credit officer'],
    recommended: [staffName[credit], 'Appraisal passed. Recommended for approval.'],
    approved: [staffName[manager], 'Approved by credit committee'],
    disbursed: [staffName[treasurer], 'Funds sent to member’s bank account'],
  };
  for (const l of loanSpecs) {
    eventRows.push([l.id, 'applied', 'Member', `Applied for ${S.fmtKes(l.principal)} over ${l.months} months`, l.appliedAt + ' 10:00:00']);
    for (const [g, amount, gStatus] of l.guarantors) {
      guaranteeRows.push([l.id, g.id, amount, gStatus, l.appliedAt + ' 10:05:00', gStatus === 'pending' ? null : l.appliedAt + ' 15:00:00']);
    }
    const steps = ['appraisal', 'recommended', 'approved', 'disbursed'];
    const reached = l.status === 'closed' ? 4 : steps.indexOf(l.status) + 1;
    steps.slice(0, reached).forEach((s, i) => eventRows.push([l.id, s, notes[s][0], notes[s][1], l.appliedAt + ` 1${i + 1}:00:00`]));
  }
  await insertMany('guarantees', ['loan_id', 'guarantor_id', 'amount', 'status', 'requested_at', 'responded_at'], guaranteeRows);
  await insertMany('loan_events', ['loan_id', 'step', 'actor', 'note', 'created_at'], eventRows);

  // Monthly contributions from joining to now, split across accounts and loan repayments.
  const channels = ['mpesa', 'mpesa', 'mpesa', 'bank', 'checkoff'];
  const paymentRows = [];
  const paymentParts = [];
  for (const m of members) {
    let shares = 0;
    for (let k = 0; S.addMonths(m.joined, k) <= T; k++) {
      const day = S.addMonths(m.joined, k);
      if (m.lateMonths && S.addMonths(day, m.lateMonths) > T) continue;
      const parts = [];
      if (shares < 6500) { const s = Math.min(k === 0 ? 2500 : 500, 6500 - shares); parts.push(['shares', s, 'Share capital', null]); shares += s; }
      if (m.holiday) parts.push(['holiday', m === grace ? 3000 : 2000, 'Holiday savings', null]);
      if (m.family) parts.push(['family', m === grace ? 3000 : 1500, 'Family savings', null]);
      parts.push(['deposits', m.monthly, 'Monthly deposit', null]);
      for (const loan of plans.get(m.id) || []) {
        const due = Math.min(loan.installment, loan.total - loan.paid);
        if (day > loan.disbursedAt && due > 0) { parts.push(['loan', due, 'Loan repayment', loan.id]); loan.paid += due; }
      }
      const channel = m.terms === 'not employed' ? pick(['standing', 'mpesa']) : pick(channels);
      const at = day + ` 0${between(7, 9)}:${between(10, 59)}:00`;
      const reference = channel === 'mpesa' ? code() : channel === 'bank' ? 'EQ' + between(100000, 999999) : channel === 'standing' ? 'SO-' + day.slice(0, 7) : 'CHK-' + day.slice(0, 7);
      paymentRows.push([m.id, parts.reduce((s, p) => s + p[1], 0), channel, reference, 'posted', channel === 'mpesa' ? null : clerk, channel === 'mpesa' ? null : manager, at]);
      paymentParts.push(parts.map(p => [m.id, p[3], p[0], p[1], p[2], at]));
    }
  }
  const paymentIds = await insertMany('payments', ['member_id', 'amount', 'channel', 'reference', 'status', 'created_by', 'approved_by', 'created_at'], paymentRows);
  const txRows = paymentParts.flatMap((parts, i) => parts.map(([memberId, loanId, account, amount, desc, at]) => [memberId, paymentIds[i], loanId, account, amount, desc, at]));
  txRows.push([grace.id, null, null, 'holiday', -45000, 'Holiday savings withdrawal', S.addMonths(T, -10) + ' 11:30:00']);
  txRows.push([grace.id, null, old.id, 'loan', old.total, 'Loan repayment (fully paid)', S.addMonths(T, -24) + ' 09:00:00']);
  await insertMany('transactions', ['member_id', 'payment_id', 'loan_id', 'account', 'amount', 'description', 'created_at'], txRows);

  // Work waiting for staff: new members, bank payments entered by the clerk, a member's M-Pesa code, a deduction change.
  await insertMany('members', ['first_name', 'last_name', 'id_number', 'kra_pin', 'phone', 'email', 'employer', 'department', 'payroll_no', 'net_salary', 'status', 'created_by', 'created_at'],
    [['Tabitha', 'Wekesa'], ['Emmanuel', 'Kibet']].map(([fn, ln]) => [fn, ln, String(between(30000000, 39999999)), 'A00' + between(1000000, 9999999) + 'K',
      '07' + between(10000000, 99999999), `${fn}.${ln}@example.com`.toLowerCase(), 'The Church of Jesus Christ of Latter-day Saints', 'Area Office',
      'P' + between(10000, 99999), between(5, 9) * 10000, 'pending', clerk, T + ' 08:40:00']));
  await insertMany('payments', ['member_id', 'amount', 'channel', 'reference', 'status', 'created_by', 'submitted_by_member', 'note', 'created_at'], [
    ...[5, 12, 20].map(mi => { const amt = between(3, 12) * 1000; return [members[mi].id, amt, 'bank', 'EQ' + between(100000, 999999), 'pending', clerk, false, JSON.stringify([{ account: 'deposits', amount: amt }]), T + ' 09:15:00']; }),
    [members[7].id, 5000, 'mpesa', code(), 'pending', null, true, JSON.stringify([{ account: 'deposits', amount: 5000 }]), T + ' 07:52:00'],
  ]);
  await insertMany('requests', ['member_id', 'type', 'details', 'created_at'], [[members[13].id, 'deduction_change',
    JSON.stringify({ shares_from: 3000, shares_to: 5000, loan_from: 0, loan_to: 0, effective: S.addMonths(T, 1).slice(0, 7) + '-01' }), T + ' 08:10:00']]);

  // One member has given notice to leave.
  await run(`UPDATE members SET status = 'exiting', exit_notice_at = ? WHERE id = ?`, S.addMonths(T, -1), members[27].id);
  await run(`INSERT INTO audit (actor, action, entity, details) VALUES ('System', 'Demo data loaded', 'system', 'Sample data — not real members')`);
}

async function main() {
  await tx(async () => {
    await run(`TRUNCATE ${TABLES.join(', ')} RESTART IDENTITY CASCADE`);
    await seed();
  });
  const n = (await all('SELECT COUNT(*) AS n FROM members'))[0].n;
  console.log('Demo data ready:', n, 'members');
}

if (require.main === module) main().catch(err => { console.error(err); process.exitCode = 1; }).finally(() => pool.end());
module.exports = main;
