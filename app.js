const express = require('express');
const app = express();
const path = require('path');

// Set view engine
app.set('view engine', 'ejs');

// Serve static files
app.use(express.static(path.join(__dirname, 'public')));
app.use(express.urlencoded({ extended: true }));

// Routes
app.get('/', (req, res) => res.render('index'));
app.get('/about', (req, res) => res.render('about'));
app.get('/services', (req, res) => res.render('services'));
app.get('/join', (req, res) => res.render('join'));
app.get('/contact', (req, res) => res.render('contact'));
app.get('/portal/login', (req, res) => {
  res.render('portal/login');
});

app.get('/portal/signup', (req, res) => {
  res.render('portal/signup');
});

app.get('/portal/dashboard', (req, res) => {
  res.render('portal/dashboard');
});


app.post('/join', (req, res) => {
  const { fullname, email, idNumber } = req.body;
  console.log(`New member: ${fullname}, ${email}, ID: ${idNumber}`);
  res.send(`<h2>Thanks ${fullname}, your application has been received!</h2><a href="/">Back to Home</a>`);
});



// Start server
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server running on http://localhost:${PORT}`));
