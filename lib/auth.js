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

// Minimal in-memory sessions (fine for the demo; swap for a persistent store in production).
const sessions = new Map();
const COOKIE = 'dsid';
const IDLE_MS = 30 * 60 * 1000;

function parseCookies(header = '') {
  return Object.fromEntries(header.split(';').filter(Boolean).map(c => {
    const i = c.indexOf('=');
    return [c.slice(0, i).trim(), decodeURIComponent(c.slice(i + 1).trim())];
  }));
}

function sessionMiddleware(req, res, next) {
  const sid = parseCookies(req.headers.cookie)[COOKIE];
  const session = sid && sessions.get(sid);
  if (session && Date.now() - session.seen < IDLE_MS) {
    session.seen = Date.now();
    req.session = session;
    req.sid = sid;
  } else {
    if (sid) sessions.delete(sid);
    req.session = { seen: Date.now() };
  }

  req.startSession = data => {
    if (req.sid) sessions.delete(req.sid);
    req.sid = crypto.randomBytes(32).toString('hex');
    req.session = { ...data, seen: Date.now() };
    sessions.set(req.sid, req.session);
    res.setHeader('Set-Cookie', `${COOKIE}=${req.sid}; HttpOnly; SameSite=Lax; Path=/`);
  };
  req.endSession = () => {
    if (req.sid) sessions.delete(req.sid);
    res.setHeader('Set-Cookie', `${COOKIE}=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0`);
  };

  // One-shot flash messages shown after a redirect.
  res.locals.flash = req.session.flash || null;
  delete req.session.flash;
  req.flash = (type, text) => { req.session.flash = { type, text }; };
  next();
}

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
