// M-Pesa Express (STK Push) through Safaricom Daraja.
// Env: MPESA_CONSUMER_KEY and MPESA_CONSUMER_SECRET (from the Daraja app).
// MPESA_ENV=production also needs MPESA_SHORTCODE and MPESA_PASSKEY for the SACCO's own Paybill.
// Without production settings it uses Safaricom's sandbox Paybill, so no real money moves.
const crypto = require('crypto');

const LIVE = process.env.MPESA_ENV === 'production';
const BASE = LIVE ? 'https://api.safaricom.co.ke' : 'https://sandbox.safaricom.co.ke';
// Safaricom's published sandbox test Paybill and its passkey (not secret).
const SHORTCODE = LIVE ? process.env.MPESA_SHORTCODE : '174379';
const PASSKEY = LIVE ? process.env.MPESA_PASSKEY : 'bfb279f9aa9bdbcf158e97dd71a467cd2e0c893059b10f78e6b72ada1ed2c919';

const configured = () => !!(process.env.MPESA_CONSUMER_KEY && process.env.MPESA_CONSUMER_SECRET && SHORTCODE && PASSKEY);

// The callback address carries a secret derived from the session secret, so only Safaricom (who we gave it to) knows it.
const callbackToken = () => crypto.createHmac('sha256', process.env.SESSION_SECRET || 'dev').update('mpesa-callback').digest('hex').slice(0, 32);

// 0722 123 456, +254722123456 and 254722123456 all become 254722123456. Returns null if it isn't a Kenyan mobile number.
function normalisePhone(input) {
  const digits = String(input || '').replace(/\D/g, '');
  const local = digits.startsWith('254') ? digits.slice(3) : digits.startsWith('0') ? digits.slice(1) : digits;
  return /^(7|1)\d{8}$/.test(local) ? '254' + local : null;
}

let cached = { token: null, expires: 0 };
async function accessToken() {
  if (cached.token && Date.now() < cached.expires) return cached.token;
  const auth = Buffer.from(`${process.env.MPESA_CONSUMER_KEY}:${process.env.MPESA_CONSUMER_SECRET}`).toString('base64');
  const r = await fetch(`${BASE}/oauth/v1/generate?grant_type=client_credentials`, { headers: { Authorization: `Basic ${auth}` }, signal: AbortSignal.timeout(10000) });
  if (!r.ok) throw new Error(`M-Pesa sign-in failed (${r.status})`);
  const body = await r.json();
  cached = { token: body.access_token, expires: Date.now() + (Number(body.expires_in) - 60) * 1000 };
  return cached.token;
}

// Daraja wants the time in Kenya (EAT) as YYYYMMDDHHmmss.
function timestamp() {
  return new Date(Date.now() + 3 * 3600 * 1000).toISOString().replace(/\D/g, '').slice(0, 14);
}

async function call(path, payload) {
  const r = await fetch(BASE + path, {
    method: 'POST',
    headers: { Authorization: `Bearer ${await accessToken()}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(15000),
  });
  return { ok: r.ok, body: await r.json().catch(() => ({})) };
}

const password = ts => Buffer.from(SHORTCODE + PASSKEY + ts).toString('base64');

// Sends the PIN prompt to the member's phone. Returns { checkoutRequestId, merchantRequestId } or { error }.
async function stkPush({ phone, amount, accountRef, description, callbackUrl }) {
  const ts = timestamp();
  const { ok, body } = await call('/mpesa/stkpush/v1/processrequest', {
    BusinessShortCode: SHORTCODE, Password: password(ts), Timestamp: ts, TransactionType: 'CustomerPayBillOnline',
    Amount: amount, PartyA: phone, PartyB: SHORTCODE, PhoneNumber: phone, CallBackURL: callbackUrl,
    AccountReference: String(accountRef).slice(0, 12), TransactionDesc: String(description).slice(0, 13),
  });
  if (ok && body.ResponseCode === '0') return { checkoutRequestId: body.CheckoutRequestID, merchantRequestId: body.MerchantRequestID };
  return { error: body.errorMessage || body.ResponseDescription || 'M-Pesa did not accept the request.' };
}

// Asks Safaricom how a prompt ended. Returns { done: false } while the member hasn't answered yet.
async function query(checkoutRequestId) {
  const ts = timestamp();
  const { body } = await call('/mpesa/stkpushquery/v1/query', { BusinessShortCode: SHORTCODE, Password: password(ts), Timestamp: ts, CheckoutRequestID: checkoutRequestId });
  if (body.ResultCode === undefined) return { done: false };
  return { done: true, code: String(body.ResultCode), desc: body.ResultDesc };
}

// Plain-language reasons for the common result codes.
const RESULT_TEXT = {
  0: 'Payment received.',
  1: 'Not enough money in M-Pesa for this payment.',
  1032: 'You cancelled the prompt.',
  1037: 'The prompt timed out before a PIN was entered. Check your phone is on and try again.',
  2001: 'The M-Pesa PIN was wrong.',
};
const resultText = (code, desc) => RESULT_TEXT[code] || desc || 'M-Pesa could not complete the payment.';

module.exports = { LIVE, configured, callbackToken, normalisePhone, stkPush, query, resultText };
