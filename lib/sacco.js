// SACCO business rules. Every number here comes from the settings or loan_products tables,
// so the real by-law values can be entered in Admin › Settings without code changes.
const { one, all, run, setting } = require('../db');

// Payment details printed on the SACCO's membership forms.
const SACCO = {
  name: 'Deseret SACCO Society Ltd',
  office: 'Galleria Office & Business Park, Nairobi',
  postal: 'P.O. Box 46162-00100, Nairobi',
  phone: '+254 20 5029300',
  phoneHref: '+254205029300',
  emails: ['deseretsacco@outlook.com', 'deseretsacco@gmail.com'],
  hours: 'Monday to Friday, 8:00am to 5:00pm',
  bank: 'Co-operative Bank of Kenya Ltd',
  branch: 'Nairobi Business Centre, Ngong Road Branch',
  account: '01120098632300',
  swift: 'KCOOKENAXXX',
  paybill: '400200',
  smsNumber: '0722520639',
};

// Board and committee seats. A member holding one is an "official" under the by-laws.
const OFFICIAL_ROLES = ['Chairperson', 'Vice-chairperson', 'Secretary', 'Treasurer', 'Board member', 'Credit committee', 'Supervisory committee'];

const CHANNELS = { mpesa: 'M-Pesa', bank: 'Bank deposit', standing: 'Standing order', checkoff: 'Check-off', cash: 'Cash' };

const ACCOUNTS = {
  shares: 'Share Capital',
  deposits: 'Deposits',
  holiday: 'Holiday Savings',
  family: 'Family Savings',
};

const LIVE_LOAN = ['guarantors', 'appraisal', 'recommended', 'approved', 'disbursed'];

const today = () => new Date().toISOString().slice(0, 10);
const now = () => new Date().toISOString().slice(0, 19).replace('T', ' ');

function addMonths(dateStr, n) {
  const d = new Date(dateStr.slice(0, 10) + 'T00:00:00Z');
  const day = d.getUTCDate();
  d.setUTCDate(1);
  d.setUTCMonth(d.getUTCMonth() + n);
  const last = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0)).getUTCDate();
  d.setUTCDate(Math.min(day, last));
  return d.toISOString().slice(0, 10);
}

const daysBetween = (a, b) => Math.round((new Date(b.slice(0, 10)) - new Date(a.slice(0, 10))) / 86400000);
const monthsBetween = (a, b) => {
  const x = new Date(a.slice(0, 10)), y = new Date(b.slice(0, 10));
  return (y.getFullYear() - x.getFullYear()) * 12 + (y.getMonth() - x.getMonth()) - (y.getDate() < x.getDate() ? 1 : 0);
};

async function balances(memberId) {
  const result = { shares: 0, deposits: 0, holiday: 0, family: 0 };
  for (const row of await all(`SELECT account, SUM(amount) AS total FROM transactions
                         WHERE member_id = ? AND account != 'loan' GROUP BY account`, memberId)) {
    result[row.account] = row.total;
  }
  return result;
}

async function balancesFor(memberIds) {
  const result = Object.fromEntries(memberIds.map(id => [id, { shares: 0, deposits: 0, holiday: 0, family: 0 }]));
  if (!memberIds.length) return result;
  for (const row of await all(`SELECT member_id, account, SUM(amount) AS total FROM transactions
                               WHERE account != 'loan' AND member_id IN (${memberIds.map(() => '?').join(',')}) GROUP BY member_id, account`, ...memberIds)) {
    result[row.member_id][row.account] = row.total;
  }
  return result;
}

// Average monthly savings over the last 3 months. By-law 64(XII) counts savings as a deduction.
async function monthlySavings(memberId) {
  const row = await one(`SELECT COALESCE(SUM(amount), 0) AS total FROM transactions
                   WHERE member_id = ? AND account != 'loan' AND amount > 0 AND created_at::date > ?`, memberId, addMonths(today(), -3));
  return Math.round(row.total / 3);
}

// By-law 64(VI): no single loan above a share of the society's capital.
async function societyLoanCap() {
  const total = (await one(`SELECT COALESCE(SUM(amount), 0) AS t FROM transactions WHERE account IN ('shares','deposits')`)).t;
  return Math.floor(total * setting('max_loan_pct_capital') / 100);
}

function schedule(principal, months, rate, method, start) {
  const rows = [];
  let balance = principal;
  const installment = quoteInstallment(principal, months, rate, method);
  for (let i = 1; i <= months; i++) {
    const interest = method === 'flat' ? Math.round(principal * rate) : Math.round(balance * rate);
    const principalPart = i === months ? balance : installment - interest;
    balance -= principalPart;
    rows.push({ no: i, due: start ? addMonths(start, i) : null, installment: principalPart + interest, interest, principal: principalPart, balance: Math.max(balance, 0) });
  }
  return rows;
}

function quoteInstallment(principal, months, rate, method) {
  if (method === 'flat') return Math.round((principal + principal * rate * months) / months);
  if (rate === 0) return Math.round(principal / months);
  return Math.round(principal * rate / (1 - Math.pow(1 + rate, -months)));
}

function quote(product, principal, months) {
  const rows = schedule(principal, months, product.rate_monthly, product.method);
  const total = rows.reduce((s, r) => s + r.installment, 0);
  return {
    installment: rows[0].installment,
    total,
    interest: total - principal,
    fee: Math.round(principal * product.fee_pct / 100),
  };
}

// Repayment position of a disbursed loan: what has been paid, what should have been paid by now,
// and how many days the oldest unpaid installment is overdue.
async function loanState(loan, paidAmount) {
  const paid = paidAmount ?? (await one(`SELECT COALESCE(SUM(amount), 0) AS paid FROM transactions WHERE loan_id = ? AND account = 'loan'`, loan.id)).paid;
  const outstanding = Math.max(loan.total_payable - paid, 0);
  if (loan.status !== 'disbursed' && loan.status !== 'closed') {
    return { paid, outstanding: loan.total_payable, arrears: 0, daysInArrears: 0, progress: 0, nextDue: null, dueCount: 0 };
  }
  const start = loan.disbursed_at;
  let dueCount = 0;
  while (dueCount < loan.months && addMonths(start, dueCount + 1) <= today()) dueCount++;
  const dueToDate = Math.min(dueCount * loan.installment, loan.total_payable);
  const arrears = Math.max(dueToDate - paid, 0);
  const firstUnpaid = Math.floor(paid / loan.installment) + 1;
  const daysInArrears = arrears > 0 ? Math.max(daysBetween(addMonths(start, firstUnpaid), today()), 0) : 0;
  return {
    paid,
    outstanding,
    arrears,
    daysInArrears,
    dueCount,
    progress: Math.round(paid / loan.total_payable * 100),
    nextDue: outstanding > 0 ? addMonths(start, Math.min(dueCount + 1, loan.months)) : null,
  };
}

function bucket(days) {
  if (days <= 0) return 'Current';
  if (days <= 30) return '1 to 30 days';
  if (days <= 60) return '31 to 60 days';
  if (days <= 90) return '61 to 90 days';
  return '90+ days';
}

// How much of a member's deposits is already pledged for other people's loans.
// A pledge on a disbursed loan shrinks as the borrower repays.
async function guaranteeExposure(memberId) {
  const rows = await all(`SELECT g.amount, l.* FROM guarantees g JOIN loans l ON l.id = g.loan_id
                    WHERE g.guarantor_id = ? AND g.status = 'accepted' AND l.status IN (${LIVE_LOAN.map(() => '?').join(',')})`,
    memberId, ...LIVE_LOAN);
  let exposure = 0;
  for (const row of await withState(rows)) {
    const share = row.status === 'disbursed' ? row.state.outstanding / row.total_payable : 1;
    exposure += Math.round(row.amount * share);
  }
  return { exposure, count: rows.length };
}

async function guarantorCapacity(memberId) {
  const { exposure, count } = await guaranteeExposure(memberId);
  const deposits = (await balances(memberId)).deposits;
  return {
    deposits,
    exposure,
    count,
    free: Math.max(deposits - exposure, 0),
    maxLoans: setting('max_loans_guaranteed'),
  };
}

// Adds each loan's repayment position as `state`.
async function withState(loans) {
  if (!loans.length) return [];
  const ids = [...new Set(loans.map(l => l.id))];
  const paid = Object.fromEntries((await all(`SELECT loan_id, SUM(amount) AS paid FROM transactions
    WHERE account = 'loan' AND loan_id IN (${ids.map(() => '?').join(',')}) GROUP BY loan_id`, ...ids)).map(r => [r.loan_id, r.paid]));
  return Promise.all(loans.map(async l => ({ ...l, state: await loanState(l, paid[l.id] || 0) })));
}

async function memberLoans(memberId, statuses = LIVE_LOAN) {
  return withState(await all(`SELECT l.*, p.name AS product_name FROM loans l JOIN loan_products p ON p.code = l.product
              WHERE l.member_id = ? AND l.status IN (${statuses.map(() => '?').join(',')}) ORDER BY l.applied_at DESC`,
    memberId, ...statuses));
}

// The member figures every eligibility check needs, fetched once.
async function borrowerPosition(member) {
  const [bal, loans, savings, societyCap, schoolThisYear] = await Promise.all([
    balances(member.id), memberLoans(member.id), monthlySavings(member.id), societyLoanCap(),
    one(`SELECT 1 AS x FROM loans WHERE member_id = ? AND product = 'school' AND status != 'rejected' AND to_char(applied_at, 'YYYY') = ?`, member.id, today().slice(0, 4)),
  ]);
  return { bal, loans, savings, societyCap, schoolThisYear: !!schoolThisYear };
}

// "Can I borrow?": the maximum for one product, with plain-language reasons when it is limited.
async function eligibility(member, product, position) {
  const { bal, loans, savings, societyCap, schoolThisYear } = position || await borrowerPosition(member);
  const outstanding = loans.reduce((s, l) => s + l.state.outstanding, 0);
  const installments = loans.filter(l => l.status === 'disbursed').reduce((s, l) => s + l.installment, 0);
  const reasons = [];

  const byDeposits = Math.max(Math.floor(bal.deposits * product.multiplier - outstanding), 0);
  const takeHome = setting('min_take_home_pct') / 100;
  const spare = Math.max(Math.floor(member.net_salary * (1 - takeHome) - installments - savings), 0);
  const unitInstallment = quoteInstallment(100000, product.max_months, product.rate_monthly, product.method);
  const bySalary = Math.floor(spare / unitInstallment * 100000);
  let max = Math.min(byDeposits, bySalary);
  let limitedBy = byDeposits <= bySalary ? 'deposits' : 'salary';

  if (product.max_salary_pct) {
    const cap = Math.floor(member.net_salary * product.max_salary_pct / 100);
    if (cap < max) { max = cap; limitedBy = 'cap'; }
  }
  if (societyCap < max) { max = societyCap; limitedBy = 'society'; }

  const minMonths = setting('min_membership_months');
  const tenure = member.joined_at ? monthsBetween(member.joined_at, today()) : 0;
  if (tenure < minMonths) reasons.push(`You need ${minMonths} months of membership. You have ${tenure}.`);
  if (loans.some(l => l.state.arrears > 0)) reasons.push('Clear the arrears on your current loan first.');
  if (loans.some(l => l.product === product.code && l.status !== 'disbursed')) reasons.push(`You already have a ${product.name} application in progress.`);
  if (product.code === 'school' && schoolThisYear) reasons.push('Only one School Fees Loan is allowed per calendar year (BL64 IX).');

  max = reasons.length ? 0 : Math.floor(max / 100) * 100;
  const explain = {
    deposits: `Limited by deposits: ${product.multiplier}× your deposits, less what you still owe.`,
    salary: `Limited by salary: loans plus savings can’t take more than ${Math.round((1 - takeHome) * 100)}% of your basic pay.`,
    society: `Limited by the society’s single-loan ceiling (${setting('max_loan_pct_capital')}% of share capital).`,
    cap: `${product.name} is capped at ${product.max_salary_pct}% of your net pay.`,
  }[limitedBy];
  return { max, reasons, explain, byDeposits, bySalary };
}

// The checks a credit officer sees on the appraisal screen.
async function appraise(loan) {
  const [member, product, bal, allLoans, guarantees, exposure, savings, societyCap] = await Promise.all([
    one('SELECT * FROM members WHERE id = ?', loan.member_id),
    one('SELECT * FROM loan_products WHERE code = ?', loan.product),
    balances(loan.member_id),
    memberLoans(loan.member_id),
    all(`SELECT g.*, m.first_name || ' ' || m.last_name AS name, m.member_no FROM guarantees g
         JOIN members m ON m.id = g.guarantor_id WHERE g.loan_id = ?`, loan.id),
    guaranteeExposure(loan.member_id),
    monthlySavings(loan.member_id),
    societyLoanCap(),
  ]);
  const others = allLoans.filter(l => l.id !== loan.id);
  const outstanding = others.reduce((s, l) => s + l.state.outstanding, 0);
  const otherInstallments = others.filter(l => l.status === 'disbursed').reduce((s, l) => s + l.installment, 0);
  const accepted = guarantees.filter(g => g.status === 'accepted');
  const ownFree = Math.max(bal.deposits - exposure.exposure, 0);
  const covered = Math.min(ownFree, loan.principal) + accepted.reduce((s, g) => s + g.amount, 0);
  const minMonths = setting('min_membership_months');
  const tenure = member.joined_at ? monthsBetween(member.joined_at, today()) : 0;
  const takeHome = setting('min_take_home_pct') / 100;
  const leftAfter = member.net_salary - otherInstallments - savings - loan.installment;
  const needsGuarantors = loan.principal > ownFree;

  const checks = [
    { label: 'Membership age', ok: tenure >= minMonths, detail: `${tenure} months (minimum ${minMonths})` },
    { label: 'Deposit multiplier', ok: loan.principal + outstanding <= bal.deposits * product.multiplier,
      detail: `Owes ${fmtKes(outstanding)} + this ${fmtKes(loan.principal)} vs limit ${fmtKes(bal.deposits * product.multiplier)} (${product.multiplier}× deposits)` },
    { label: 'Two-thirds deduction rule (BL64 XII)', ok: leftAfter >= member.net_salary * takeHome,
      detail: `After loans ${fmtKes(otherInstallments + loan.installment)} and savings ${fmtKes(savings)}, ${fmtKes(leftAfter)} of ${fmtKes(member.net_salary)} basic pay is left (minimum ${Math.round(takeHome * 100)}%)` },
    { label: 'Guarantors (BL64 XVIII)', ok: !needsGuarantors || accepted.length >= product.min_guarantors,
      detail: needsGuarantors ? `${accepted.length} accepted of ${product.min_guarantors} required` : 'Not needed: the loan is within the borrower’s own free deposits' },
    { label: 'Society single-loan limit (BL64 VI)', ok: loan.principal <= societyCap,
      detail: `Up to ${setting('max_loan_pct_capital')}% of share capital = ${fmtKes(societyCap)}` },
    { label: 'Security cover', ok: covered >= loan.principal,
      detail: `Own free deposits ${fmtKes(Math.min(ownFree, loan.principal))} + guarantees ${fmtKes(accepted.reduce((s, g) => s + g.amount, 0))} = ${fmtKes(covered)}` },
    { label: 'No arrears', ok: !others.some(l => l.state.arrears > 0),
      detail: others.some(l => l.state.arrears > 0) ? 'Existing loan is in arrears' : 'All existing loans current' },
  ];
  if (member.terms === 'contract') {
    const lastDue = addMonths(today(), loan.months);
    checks.push({ label: 'Ends within contract (BL64 XXV)', ok: !!member.contract_end && lastDue <= member.contract_end,
      detail: `Last installment ${fmtDate(lastDue)} · contract ends ${fmtDate(member.contract_end)}` });
  }
  if (product.max_salary_pct) {
    checks.push({ label: 'Salary cap', ok: loan.principal <= member.net_salary * product.max_salary_pct / 100,
      detail: `Up to ${product.max_salary_pct}% of net pay = ${fmtKes(member.net_salary * product.max_salary_pct / 100)}` });
  }
  return { checks, passed: checks.every(c => c.ok), guarantees, covered, member, product, bal, needsGuarantors };
}

// Moves a loan out of the guarantor stage once enough guarantors have accepted and the loan is covered.
// Books a payment's parts to the member's accounts and closes any loan it pays off.
// Call inside a transaction, after the payment row is marked posted.
async function postPayment(p) {
  for (const part of JSON.parse(p.note || '[]')) {
    const desc = part.account === 'loan' ? 'Loan repayment' : `${CHANNELS[p.channel]} · ${ACCOUNTS[part.account]}`;
    await run(`INSERT INTO transactions (member_id, payment_id, loan_id, account, amount, description, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)`,
      p.member_id, p.id, part.loan_id || null, part.account, part.amount, desc, p.created_at);
    if (part.loan_id) {
      const loan = await one('SELECT * FROM loans WHERE id = ?', part.loan_id);
      if ((await loanState(loan)).outstanding === 0) {
        await run(`UPDATE loans SET status = 'closed' WHERE id = ?`, loan.id);
        await run('INSERT INTO loan_events (loan_id, step, actor, note, created_at) VALUES (?, ?, ?, ?, ?)', loan.id, 'closed', 'System', 'Loan fully repaid', now());
      }
    }
  }
}

async function advanceIfCovered(loanId, logEvent) {
  const loan = await one('SELECT * FROM loans WHERE id = ?', loanId);
  if (loan.status !== 'guarantors') return;
  const { checks } = await appraise(loan);
  const ready = checks.find(c => c.label.startsWith('Guarantors')).ok && checks.find(c => c.label === 'Security cover').ok;
  if (ready) {
    await run(`UPDATE loans SET status = 'appraisal' WHERE id = ?`, loanId);
    await logEvent(loanId, 'appraisal', 'System', 'Guarantors complete: sent to credit officer');
  }
}

function fmtKes(n) {
  return 'KES ' + Math.round(n || 0).toLocaleString('en-KE');
}

function fmtDate(s) {
  if (!s) return '—';
  return new Date(s.slice(0, 10) + 'T00:00:00Z').toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' });
}

const esc = s => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

const STATUS_LABELS = {
  guarantors: 'Awaiting guarantors',
  appraisal: 'Credit appraisal',
  recommended: 'Awaiting approval',
  approved: 'Awaiting disbursement',
  disbursed: 'Active',
  closed: 'Fully paid',
  rejected: 'Declined',
};

module.exports = {
  SACCO, OFFICIAL_ROLES, CHANNELS, ACCOUNTS, LIVE_LOAN, STATUS_LABELS,
  today, now, addMonths, daysBetween, monthsBetween,
  balances, balancesFor, monthlySavings, societyLoanCap, schedule, quote, quoteInstallment, loanState, bucket,
  guaranteeExposure, guarantorCapacity, withState, memberLoans, borrowerPosition, eligibility, appraise, advanceIfCovered, postPayment,
  fmtKes, fmtDate, esc,
};
