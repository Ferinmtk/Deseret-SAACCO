// PostgreSQL access (Neon). Queries use `?` placeholders, converted to $1, $2… here,
// so call sites read the same as plain SQL.
const { Pool, types } = require('pg');
const { AsyncLocalStorage } = require('async_hooks');

// Return dates and timestamps as plain strings ("2026-10-20", "2026-10-20 09:15:00")
// and counts/sums as numbers, which is what the rest of the app works with.
types.setTypeParser(1082, v => v); // date
types.setTypeParser(1114, v => v); // timestamp
types.setTypeParser(20, v => Number(v)); // bigint (COUNT, SUM of integers)
types.setTypeParser(1700, v => Number(v)); // numeric

if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL is not set. Run `vercel env pull .env.local` first.');

// pg treats sslmode=require as verify-full already; say so explicitly to avoid its warning.
const connectionString = process.env.DATABASE_URL.replace('sslmode=require', 'sslmode=verify-full');
const pool = new Pool({ connectionString, max: 5 });
// On Vercel, lets idle connections close cleanly before a function is suspended.
if (process.env.VERCEL) require('@vercel/functions').attachDatabasePool(pool);

const txClient = new AsyncLocalStorage();

function toPg(sql) {
  let i = 0;
  return sql.replace(/\?/g, () => '$' + ++i);
}

async function query(sql, params) {
  const client = txClient.getStore() || pool;
  return client.query(toPg(sql), params);
}

const one = async (sql, ...params) => (await query(sql, params)).rows[0];
const all = async (sql, ...params) => (await query(sql, params)).rows;

// INSERTs return the new row's id as lastInsertRowid.
async function run(sql, ...params) {
  const isInsert = /^\s*INSERT/i.test(sql) && !/RETURNING/i.test(sql);
  const result = await query(isInsert ? sql + ' RETURNING *' : sql, params);
  return { lastInsertRowid: result.rows[0] && result.rows[0].id, changes: result.rowCount };
}

// Runs fn inside a transaction; every one/all/run call made within it uses the same connection.
async function tx(fn) {
  if (txClient.getStore()) return fn();
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await txClient.run(client, fn);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

// Settings are read on every request (one small query) and then available synchronously.
let settingsCache = {};
async function loadSettings() {
  settingsCache = Object.fromEntries((await all('SELECT key, value FROM settings')).map(r => [r.key, Number(r.value)]));
}
const setting = key => (key in settingsCache ? settingsCache[key] : null);

async function audit(actor, action, entity, entityId, details) {
  await run('INSERT INTO audit (actor, action, entity, entity_id, details) VALUES (?, ?, ?, ?, ?)',
    actor, action, entity || null, entityId || null, details || null);
}

module.exports = { pool, one, all, run, tx, setting, loadSettings, audit };
