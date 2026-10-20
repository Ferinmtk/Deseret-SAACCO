// Security basics: response headers, CSRF tokens for signed-in pages, and sign-in lockout.
const crypto = require('crypto');
const { one, run } = require('../db');

// Inline scripts and style attributes are still used in the templates, so they are allowed for now;
// moving them to files would let us drop 'unsafe-inline'.
const CSP = [
  "default-src 'self'",
  "script-src 'self' 'unsafe-inline' https://cdn.jsdelivr.net",
  "style-src 'self' 'unsafe-inline' https://cdn.jsdelivr.net https://fonts.googleapis.com",
  "font-src 'self' https://fonts.gstatic.com https://cdn.jsdelivr.net",
  "img-src 'self' data:",
  "frame-src https://www.google.com",
  "connect-src 'self'",
  "form-action 'self'",
  "frame-ancestors 'none'",
  "base-uri 'self'",
].join('; ');

function securityHeaders(req, res, next) {
  res.setHeader('Content-Security-Policy', CSP);
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
  if (process.env.VERCEL) res.setHeader('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
  res.removeHeader('X-Powered-By');
  next();
}

// Every POST from the portal and admin must carry the session's token (added to forms by app-bottom).
function csrf(req, res, next) {
  if (!req.session.csrf) req.session.csrf = crypto.randomBytes(24).toString('hex');
  res.locals.csrfToken = req.session.csrf;
  if (req.method !== 'POST' || req.path === '/login') return next();
  const sent = String(req.body._csrf || '');
  const ok = sent.length === req.session.csrf.length && crypto.timingSafeEqual(Buffer.from(sent), Buffer.from(req.session.csrf));
  if (ok) return next();
  res.status(403).send('<h2>This form has expired.</h2><p>Please go back, refresh the page and try again.</p>');
}

// Sign-in lockout: 5 wrong passwords within 15 minutes locks the account (and the device's IP) for 15 minutes.
const MAX_FAILURES = 5;
const WINDOW_MIN = 15;
const LOCK_MIN = 15;
const keysFor = (kind, id, req) => [`${kind}:${id}`, `ip:${req.ip}`];

async function lockedFor(kind, id, req) {
  for (const key of keysFor(kind, id, req)) {
    const row = await one(`SELECT CEIL(EXTRACT(EPOCH FROM (locked_until - now())) / 60) AS mins FROM login_attempts WHERE key = ? AND locked_until > now()`, key);
    if (row) return Number(row.mins);
  }
  return 0;
}

async function recordFailure(kind, id, req) {
  for (const key of keysFor(kind, id, req)) {
    // IP limit is looser, since several people may share an office connection.
    const limit = key.startsWith('ip:') ? MAX_FAILURES * 4 : MAX_FAILURES;
    await run(`INSERT INTO login_attempts (key, failures, first_failed_at) VALUES (?, 1, now())
               ON CONFLICT (key) DO UPDATE SET
                 failures = CASE WHEN login_attempts.first_failed_at < now() - interval '${WINDOW_MIN} minutes' THEN 1 ELSE login_attempts.failures + 1 END,
                 first_failed_at = CASE WHEN login_attempts.first_failed_at < now() - interval '${WINDOW_MIN} minutes' THEN now() ELSE login_attempts.first_failed_at END`, key);
    await run(`UPDATE login_attempts SET locked_until = now() + interval '${LOCK_MIN} minutes', failures = 0 WHERE key = ? AND failures >= ?`, key, limit);
  }
}

async function clearFailures(kind, id) {
  await run('DELETE FROM login_attempts WHERE key = ?', `${kind}:${id}`);
}

module.exports = { securityHeaders, csrf, lockedFor, recordFailure, clearFailures };
