const crypto = require('crypto');

// Passwords: scrypt with a random salt, stored as "salt:hash".
function hashPassword(password) {
  const salt = crypto.randomBytes(16).toString('hex');
  return salt + ':' + crypto.scryptSync(password, salt, 32).toString('hex');
}

function checkPassword(password, stored) {
  if (!stored) return false;
  const [salt, hash] = stored.split(':');
  const candidate = crypto.scryptSync(password, salt, 32);
  return crypto.timingSafeEqual(candidate, Buffer.from(hash, 'hex'));
}

// Sessions live in the database (session table), so sign-ins survive restarts and deploys.
const session = require('express-session');
const PgStore = require('connect-pg-simple')(session);
const { pool } = require('../db');

const IDLE_MS = 30 * 60 * 1000;

const sessionStore = session({
  store: new PgStore({ pool, tableName: 'session' }),
  name: 'dsid',
  secret: process.env.SESSION_SECRET || 'dev-only-secret',
  resave: false,
  saveUninitialized: false,
  rolling: true, // sign out after 30 idle minutes
  cookie: { httpOnly: true, sameSite: 'lax', secure: !!process.env.VERCEL, maxAge: IDLE_MS },
});

function sessionHelpers(req, res, next) {
  // A fresh session id on sign-in prevents session fixation.
  req.startSession = data => new Promise((resolve, reject) => req.session.regenerate(err => {
    if (err) return reject(err);
    Object.assign(req.session, data);
    req.session.save(e => (e ? reject(e) : resolve()));
  }));
  req.endSession = () => new Promise(resolve => req.session.destroy(() => {
    res.clearCookie('dsid');
    resolve();
  }));

  // One-shot flash messages shown after a redirect.
  res.locals.flash = req.session.flash || null;
  delete req.session.flash;
  req.flash = (type, text) => { req.session.flash = { type, text }; };
  next();
}

const sessionMiddleware = [sessionStore, sessionHelpers];

function requireMember(req, res, next) {
  if (req.session.memberId) return next();
  res.redirect('/portal/login');
}

function requireStaff(...roles) {
  return (req, res, next) => {
    if (!req.session.staffId) return res.redirect('/admin/login');
    if (roles.length && !roles.includes(req.session.staffRole)) {
      return res.status(403).render('admin/denied', { title: 'Not allowed' });
    }
    next();
  };
}

module.exports = { hashPassword, checkPassword, sessionMiddleware, requireMember, requireStaff };
