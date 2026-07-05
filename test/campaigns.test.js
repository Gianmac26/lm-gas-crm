/**
 * Pruebas del módulo de Campañas: esquema, importar CSV, envío con 2 fuentes.
 * Corre contra una base SQLite temporal (no toca producción).
 *   Ejecutar: npm test
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const TMP_DB = path.join(os.tmpdir(), `lmtest_campaigns_${Date.now()}.db`);
process.env.TURSO_DATABASE_URL = 'file:' + TMP_DB;
delete process.env.TURSO_AUTH_TOKEN;
process.env.WHATSAPP_ACCESS_TOKEN = 'test-token';
process.env.WHATSAPP_PHONE_NUMBER_ID = '000000000';

const app = require('../server');
const { db, row, rows } = require('../lib/db');

let base, server;

test.before(async () => {
  await new Promise(r => { server = app.listen(0, r); });
  base = `http://localhost:${server.address().port}`;
  await fetch(`${base}/api/config`); // dispara la creación de tablas + seed
});

test.after(() => {
  server?.close();
  try { fs.unlinkSync(TMP_DB); } catch {}
});

async function api(method, p, body) {
  const r = await fetch(base + p, {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await r.text();
  let data; try { data = JSON.parse(text); } catch { data = text; }
  return { status: r.status, data };
}

async function createClient({ name, phone }) {
  const { data } = await api('POST', '/api/clients', {
    name, address: '', reference: '', zone: 'Otra', phone,
    type: 'Residencial', business_type: '', preferred_balloon: '10kg',
    purchase_frequency: 'irregular', notes: '', is_vip: false,
  });
  return data.id;
}

test('initDb crea las tablas campaign_contacts y campaign_logs con las columnas nuevas', async () => {
  const contactsCols = rows(await db.execute({ sql: 'PRAGMA table_info(campaign_contacts)', args: [] })).map(c => c.name);
  assert.ok(contactsCols.includes('phone_normalized'), 'debe tener phone_normalized');
  assert.ok(contactsCols.includes('import_batch'), 'debe tener import_batch');
  assert.ok(contactsCols.includes('nombre'), 'debe tener nombre');
  assert.ok(contactsCols.includes('zona'), 'debe tener zona');

  const logsCols = rows(await db.execute({ sql: 'PRAGMA table_info(campaign_logs)', args: [] })).map(c => c.name);
  assert.ok(logsCols.includes('contact_source'), 'debe tener contact_source');
  assert.ok(logsCols.includes('campaign_contact_id'), 'debe tener campaign_contact_id');
  assert.ok(logsCols.includes('client_id'), 'debe conservar client_id');
});
