// M-Pesa prompts: Safaricom's callback, plus the shared code that turns a confirmed prompt into a posted payment.
// A prompt is only posted once Safaricom itself confirms it: the callback is checked with a status query,
// and if the callback never arrives the member's waiting page asks Safaricom directly.
const crypto = require('crypto');
const express = require('express');
const { one, run, tx, audit } = require('../db');
const S = require('../lib/sacco');
const M = require('../lib/mpesa');

const router = express.Router();

// Settles a pending prompt once. Safe to call twice: only the first call that finds it pending does anything.
async function settle(id, { code, desc, receipt, amount }) {
  return tx(async () => {
    const r = await one(`SELECT * FROM mpesa_requests WHERE id = ? FOR UPDATE`, id);
    if (!r) return null;
    if (r.status !== 'pending') {
      // The status query got there first without a receipt number; the callback fills it in.
      if (receipt && r.status === 'paid' && !r.receipt) {
        await run('UPDATE mpesa_requests SET receipt = ? WHERE id = ?', receipt, r.id);
        await run('UPDATE payments SET reference = ? WHERE id = ?', receipt, r.payment_id);
      }
      return r;
    }
    if (code !== '0') {
      await run(`UPDATE mpesa_requests SET status = 'failed', result_code = ?, result_desc = ? WHERE id = ?`, code, M.resultText(code, desc), r.id);
      return { ...r, status: 'failed' };
    }
    if (amount !== undefined && Number(amount) !== r.amount) {
      // Should never happen; a person checks it rather than the system guessing.
      await run(`UPDATE mpesa_requests SET status = 'review', result_code = ?, result_desc = ? WHERE id = ?`, code, `Amount ${amount} does not match ${r.amount}`, r.id);
      await audit('M-Pesa', 'Prompt amount mismatch', 'member', r.member_id, `${r.checkout_request_id}: paid ${amount}, asked ${r.amount}`);
      return { ...r, status: 'review' };
    }
    const reference = receipt || `STK${r.id}`;
    const p = await one(`INSERT INTO payments (member_id, amount, channel, reference, status, submitted_by_member, note, created_at)
                         VALUES (?, ?, 'mpesa', ?, 'posted', true, ?, ?) RETURNING *`, r.member_id, r.amount, reference, r.split, S.now());
    await S.postPayment(p);
    await run(`UPDATE mpesa_requests SET status = 'paid', result_code = '0', result_desc = ?, receipt = ?, payment_id = ? WHERE id = ?`,
      M.resultText('0'), receipt || null, p.id, r.id);
    await audit('M-Pesa', 'M-Pesa prompt paid', 'payment', p.id, `${S.fmtKes(r.amount)} ${reference}${r.simulated ? ' (demo)' : ''}`);
    return { ...r, status: 'paid', receipt: reference };
  });
}

// Called by the waiting page: moves a pending prompt along if Safaricom has an answer.
async function refresh(r) {
  if (r.status !== 'pending') return r;
  const age = (Date.now() - new Date(r.created_at + 'Z').getTime()) / 1000;
  if (r.simulated) {
    // Demo only: pretend the member entered their PIN a few seconds after the prompt.
    return age > 6 ? settle(r.id, { code: '0', receipt: 'SIM' + crypto.randomBytes(4).toString('hex').toUpperCase() }) : r;
  }
  if (age > 300) return settle(r.id, { code: '1037', desc: 'No answer from M-Pesa.' });
  const checkedAgo = r.last_checked_at ? (Date.now() - new Date(r.last_checked_at + 'Z').getTime()) / 1000 : Infinity;
  if (age < 12 || checkedAgo < 6) return r;
  await run('UPDATE mpesa_requests SET last_checked_at = ? WHERE id = ?', S.now(), r.id);
  const q = await M.query(r.checkout_request_id).catch(() => ({ done: false }));
  return q.done ? settle(r.id, { code: q.code, desc: q.desc }) : r;
}

// Safaricom posts the outcome here. It always gets a 200 so it doesn't keep retrying.
router.post('/callback/:token', express.json({ limit: '20kb' }), async (req, res) => {
  const ok = req.params.token.length === M.callbackToken().length && crypto.timingSafeEqual(Buffer.from(req.params.token), Buffer.from(M.callbackToken()));
  const cb = req.body && req.body.Body && req.body.Body.stkCallback;
  if (ok && cb && cb.CheckoutRequestID) {
    const r = await one('SELECT * FROM mpesa_requests WHERE checkout_request_id = ?', String(cb.CheckoutRequestID));
    if (r) {
      const item = name => ((cb.CallbackMetadata && cb.CallbackMetadata.Item) || []).find(i => i.Name === name)?.Value;
      const code = String(cb.ResultCode);
      if (code !== '0') await settle(r.id, { code, desc: cb.ResultDesc });
      else {
        // Don't take the callback's word for a payment: confirm it with Safaricom first.
        const q = await M.query(r.checkout_request_id).catch(() => ({ done: false }));
        if (q.done && q.code === '0') await settle(r.id, { code: '0', receipt: String(item('MpesaReceiptNumber') || ''), amount: item('Amount') });
      }
    }
  }
  res.json({ ResultCode: 0, ResultDesc: 'Accepted' });
});

module.exports = { router, settle, refresh };
