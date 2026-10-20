const express = require('express');
const app = express();
const path = require('path');
const { sessionMiddleware } = require('./lib/auth');
const S = require('./lib/sacco');
require('./seed');

// Set view engine
app.set('view engine', 'ejs');

// Serve static files
app.use(express.static(path.join(__dirname, 'public')));
app.use(express.urlencoded({ extended: true }));
app.use((req, res, next) => { req.body ??= {}; next(); });
app.use(sessionMiddleware);
app.use((req, res, next) => {
  Object.assign(res.locals, { S, title: null, path: req.path });
  next();
});

// Routes
app.get('/', (req, res) => {
  res.render('index');
});

app.get('/about', (req, res) => res.render('about'));
app.get('/services', (req, res) => res.render('services'));
app.get('/join', (req, res) => res.render('join'));
app.get('/contact', (req, res) => res.render('contact'));


app.use('/portal', require('./routes/portal'));

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

// Start server
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server running on http://localhost:${PORT}`));
