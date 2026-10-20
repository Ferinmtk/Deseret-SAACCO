const express = require('express');
const app = express();
const path = require('path');
const { sessionMiddleware } = require('./lib/auth');
const { loadSettings } = require('./db');
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
app.get('/contact', (req, res) => res.render('contact'));


app.use('/portal', appMiddleware, require('./routes/portal'));
app.use('/admin', appMiddleware, require('./routes/admin'));

app.post('/join', (req, res) => {
  const { fullname, email, idNumber } = req.body;
  console.log(`New member: ${fullname}, ${email}, ID: ${idNumber}`);
  res.send(`<h2>Thanks ${fullname}, your application has been received!</h2><a href="/">Back to Home</a>`);
});


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
