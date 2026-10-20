const express = require('express');
const app = express();
const path = require('path');
const { sessionMiddleware } = require('./lib/auth');
const { loadSettings, run } = require('./db');
const S = require('./lib/sacco');

// Set view engine
app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));
app.set('trust proxy', 1); // behind Vercel's proxy; needed for secure cookies

// Serve static files
app.use(express.static(path.join(__dirname, 'public')));
app.use(express.urlencoded({ extended: true }));
app.use((req, res, next) => { req.body ??= {}; next(); });
app.use((req, res, next) => {
  Object.assign(res.locals, { S, title: null, path: req.path });
  next();
});

// Portal and admin need a session and the current rules; the public pages don't.
const appMiddleware = [sessionMiddleware, async (req, res, next) => { await loadSettings(); next(); }];

// Routes
app.get('/', (req, res) => {
  res.render('index');
});

app.get('/about', (req, res) => res.render('about'));
app.get('/services', (req, res) => res.render('services'));
app.get('/join', (req, res) => res.render('join'));
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
