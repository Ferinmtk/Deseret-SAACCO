-- M-Pesa Express (STK Push): the member is prompted for their PIN on their phone.
-- One row per prompt; it becomes a posted payment once Safaricom confirms it.
CREATE TABLE mpesa_requests (
  id SERIAL PRIMARY KEY,
  member_id INTEGER NOT NULL REFERENCES members(id),
  phone TEXT NOT NULL,
  amount INTEGER NOT NULL,
  split TEXT NOT NULL,                      -- where the money goes, same JSON shape as payments.note
  checkout_request_id TEXT UNIQUE NOT NULL,
  merchant_request_id TEXT,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','paid','failed','review')),
  result_code TEXT,
  result_desc TEXT,
  receipt TEXT,
  payment_id INTEGER REFERENCES payments(id),
  simulated BOOLEAN NOT NULL DEFAULT false,
  last_checked_at TIMESTAMP(0),
  created_at TIMESTAMP(0) NOT NULL DEFAULT now()
);
CREATE INDEX mpesa_requests_member ON mpesa_requests (member_id, created_at DESC);
