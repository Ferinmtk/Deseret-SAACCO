const express = require('express');
const app = express();
const path = require('path');
const { sessionMiddleware } = require('./lib/auth');
const { loadSettings, run, one, tx } = require('./db');
const S = require('./lib/sacco');
const { securityHeaders, csrf } = require('./lib/security');

// Set view engine
app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));
app.set('trust proxy', 1); // behind Vercel's proxy; needed for secure cookies
app.disable('x-powered-by');
app.use(securityHeaders);

// Serve static files
app.use(express.static(path.join(__dirname, 'public')));
app.use(express.urlencoded({ extended: true }));
app.use((req, res, next) => { req.body ??= {}; next(); });
app.use((req, res, next) => {
  // DEMO_MODE=1 shows the demo sign-in details; leave it unset for real use.
  Object.assign(res.locals, { S, title: null, path: req.path, demo: process.env.DEMO_MODE === '1' });
  next();
});

// Portal and admin need a session and the current rules; the public pages don't.
const appMiddleware = [sessionMiddleware, csrf, async (req, res, next) => { await loadSettings(); next(); }];

// Routes
app.get('/', (req, res) => {
  res.render('index');
});

app.get('/about', (req, res) => res.render('about'));
app.get('/services', (req, res) => res.render('services'));
app.get('/join', (req, res) => res.render('join'));
// Online version of the paper "Application for Membership" form. Creates a pending member
// that a manager approves in Admin, exactly like an application typed in by the clerk.
const APPLY_FIELDS = ['title', 'first_name', 'last_name', 'date_of_birth', 'id_number', 'kra_pin', 'phone', 'office_phone', 'email', 'address', 'ward',
  'terms', 'contract_end', 'department', 'designation', 'payroll_no', 'bank_name', 'bank_branch', 'bank_account', 'monthly_contribution',
  'nok_name', 'nok_relationship', 'nok_id', 'nok_phone', 'nok_address', 'witness', 'agree_bylaws', 'agree_data', 'signature'];

app.get('/join/apply', (req, res) => res.render('apply', { form: {}, errors: [] }));

app.post('/join/apply', async (req, res) => {
  const f = Object.fromEntries(APPLY_FIELDS.map(k => [k, String(req.body[k] || '').trim().slice(0, 200)]));
  if (req.body.website) return res.redirect('/join/applied'); // honeypot
  if (!['permanent', 'contract', 'not employed'].includes(f.terms)) f.terms = 'permanent';
  f.phone = f.phone.replace(/[\s-]/g, '');
  f.kra_pin = f.kra_pin.toUpperCase();
  const age = f.date_of_birth ? (Date.now() - new Date(f.date_of_birth)) / (365.25 * 86400000) : 0;
  const monthly = parseInt(f.monthly_contribution, 10) || 0;
  const errors = [];
  if (!f.first_name || !f.last_name) errors.push('Enter your first name and surname.');
  if (!f.date_of_birth || !(age > 0)) errors.push('Enter your date of birth.');
  else if (age < 18) errors.push('Members must be 18 or older.');
  if (!/^[A-Z0-9]{6,12}$/i.test(f.id_number)) errors.push('Enter your ID or passport number.');
  if (!/^[AP]\d{9}[A-Z]$/.test(f.kra_pin)) errors.push('Enter your KRA PIN, e.g. A001234567Z.');
  if (!/^(0|\+?254)[17]\d{8}$/.test(f.phone)) errors.push('Enter a Kenyan mobile number, e.g. 0712345678.');
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(f.email)) errors.push('Enter a valid email address.');
  if (!f.address) errors.push('Enter your present address.');
  if (f.terms === 'contract' && !f.contract_end) errors.push('Enter when your contract ends.');
  if (f.terms !== 'not employed' && !f.payroll_no) errors.push('Enter your payroll number.');
  if (!f.bank_name || !f.bank_branch || !f.bank_account) errors.push('Enter your bank, branch and account number.');
  if (monthly < 1000) errors.push('The monthly contribution must be at least KES 1,000.');
  if (!f.nok_name || !f.nok_relationship || !f.nok_phone) errors.push('Enter your next of kin’s name, relationship and phone number.');
  if (!f.agree_bylaws || !f.agree_data) errors.push('Tick both declarations.');
  if (!f.signature) errors.push('Type your full name as your signature.');
  if (!errors.length && await one(`SELECT 1 AS x FROM members WHERE id_number = ? AND status != 'rejected'`, f.id_number)) {
    errors.push('An application or membership with this ID number already exists. Please contact the office.');
  }
  if (errors.length) return res.status(400).render('apply', { form: f, errors });

  const employed = f.terms !== 'not employed';
  const id = await tx(async () => {
    const id = (await run(`INSERT INTO members (title, first_name, last_name, date_of_birth, id_number, kra_pin, phone, office_phone, email, address, ward,
                           employer, department, designation, terms, contract_end, payroll_no, bank_name, bank_branch, bank_account,
                           monthly_contribution, status, source, declared_at)
                           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', 'online', now())`,
      f.title || null, f.first_name, f.last_name, f.date_of_birth, f.id_number.toUpperCase(), f.kra_pin, f.phone, f.office_phone || null, f.email, f.address, f.ward || null,
      employed ? 'The Church of Jesus Christ of Latter-day Saints' : null, employed ? f.department || null : null, employed ? f.designation || null : null,
      f.terms, f.terms === 'contract' ? f.contract_end : null, employed ? f.payroll_no : null, f.bank_name, f.bank_branch, f.bank_account, monthly)).lastInsertRowid;
    await run('INSERT INTO nominees (member_id, name, relationship, id_number, phone, address, witness, share_pct) VALUES (?, ?, ?, ?, ?, ?, ?, 100)',
      id, f.nok_name, f.nok_relationship, f.nok_id || null, f.nok_phone, f.nok_address || null, f.witness || null);
    await run(`INSERT INTO audit (actor, action, entity, entity_id, details) VALUES (?, 'Applied online for membership', 'member', ?, ?)`,
      `${f.first_name} ${f.last_name}`, id, `Signed as "${f.signature}"`);
    return id;
  });
  res.redirect('/join/applied?ref=' + id);
});

app.get('/join/applied', async (req, res) => {
  const m = await one(`SELECT id FROM members WHERE id = ? AND source = 'online' AND status = 'pending'`, Number(req.query.ref) || 0);
  res.render('applied', { m, ref: m ? 'APP-' + String(m.id).padStart(5, '0') : null });
});

app.get('/contact', (req, res) => res.render('contact', { sent: req.query.sent === '1' }));

app.post('/contact', async (req, res) => {
  const form = Object.fromEntries(['name', 'email', 'phone', 'message'].map(k => [k, String(req.body[k] || '').trim()]));
  if (req.body.website) return res.redirect('/contact?sent=1#message'); // honeypot: quietly drop bot submissions
  const error = !form.name ? 'Please enter your name.'
    : !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(form.email) ? 'Please enter a valid email address.'
    : form.message.length < 5 ? 'Please write your message.'
    : null;
  if (error) return res.status(400).render('contact', { error, form });
  await run('INSERT INTO contact_messages (name, email, phone, message) VALUES (?, ?, ?, ?)',
    form.name.slice(0, 100), form.email.slice(0, 200), form.phone.slice(0, 30), form.message.slice(0, 3000));
  res.redirect('/contact?sent=1#message');
});


app.use('/portal', appMiddleware, require('./routes/portal'));
app.use('/admin', appMiddleware, require('./routes/admin'));

app.get("/faqs", (req, res) => {
  res.render("faqs");
});

// Printable versions of the paper forms (print or save as PDF from the browser; PDFs are also in /forms).
app.get('/forms/:name', (req, res, next) => {
  if (!['membership', 'deductions', 'nominee'].includes(req.params.name)) return next();
  res.render('forms/' + req.params.name);
});

app.get("/resources", (req, res) => {
  res.render("resources");
});

// Don't leak stack traces to visitors.
app.use((err, req, res, next) => {
  console.error(err);
  res.status(500).send('<h2>Something went wrong.</h2><p>Please try again, or contact the SACCO office.</p><a href="/">Home</a>');
});

// Vercel imports the app; locally, `npm start` runs this file directly.
if (require.main === module) {
  const PORT = process.env.PORT || 3000;
  app.listen(PORT, () => console.log(`Server running on http://localhost:${PORT}`));
}

module.exports = app;
