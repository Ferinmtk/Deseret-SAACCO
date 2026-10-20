// Applies any migrations/NNN_*.sql files that haven't run yet, in order, each in its own transaction.
// Uses the direct (unpooled) connection, as Neon recommends for schema changes.
const fs = require('fs');
const path = require('path');
const { Client } = require('pg');

async function migrate() {
  const url = process.env.DATABASE_URL_UNPOOLED || process.env.DATABASE_URL;
  const client = new Client({ connectionString: url.replace('sslmode=require', 'sslmode=verify-full') });
  await client.connect();
  try {
    await client.query('CREATE TABLE IF NOT EXISTS schema_migrations (name TEXT PRIMARY KEY, applied_at TIMESTAMP(0) NOT NULL DEFAULT now())');
    const done = new Set((await client.query('SELECT name FROM schema_migrations')).rows.map(r => r.name));
    const dir = path.join(__dirname, '..', 'migrations');
    for (const file of fs.readdirSync(dir).filter(f => f.endsWith('.sql')).sort()) {
      if (done.has(file)) continue;
      await client.query('BEGIN');
      try {
        await client.query(fs.readFileSync(path.join(dir, file), 'utf8'));
        await client.query('INSERT INTO schema_migrations (name) VALUES ($1)', [file]);
        await client.query('COMMIT');
        console.log('Applied', file);
      } catch (err) {
        await client.query('ROLLBACK');
        throw new Error(`${file} failed: ${err.message}`);
      }
    }
  } finally {
    await client.end();
  }
}

if (require.main === module) migrate().catch(err => { console.error(err.message); process.exit(1); });
module.exports = migrate;
