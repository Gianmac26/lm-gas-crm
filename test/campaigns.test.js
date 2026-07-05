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

test('POST /api/campaigns/import-contacts importa válidas y cuenta duplicados/inválidas', async () => {
  await createClient({ name: 'Cliente Existente', phone: '51911111111' });

  const csv = [
    'telefono,nombre_o_referencia,zona',
    '51922222222,Prospecto Uno,San Borja',
    '51911111111,Ya Es Cliente,Surco',
    'no-es-telefono,Invalido,Otra',
    '51922222222,Prospecto Uno Repetido,San Borja',
  ].join('\n');

  const res = await api('POST', '/api/campaigns/import-contacts', { csv });
  assert.equal(res.status, 200);
  assert.equal(res.data.summary.total_filas, 4);
  assert.equal(res.data.summary.importados, 1);
  assert.equal(res.data.summary.ya_cliente, 1);
  assert.equal(res.data.summary.ya_importado, 1);
  assert.equal(res.data.summary.invalidas, 1);
  assert.equal(res.data.contacts.length, 1);
  assert.equal(res.data.contacts[0].telefono, '51922222222');
  assert.equal(res.data.contacts[0].zona, 'San Borja');
  assert.equal(res.data.contacts[0].dias_sin_pedir, null);
  assert.match(res.data.import_batch, /^IMPORTADO_\d{4}-\d{2}-\d{2}$/);
});

test('POST /api/campaigns/import-contacts reimportar el mismo CSV no duplica', async () => {
  const csv = ['telefono,nombre_o_referencia', '51933333333,Prospecto Dos'].join('\n');

  const first = await api('POST', '/api/campaigns/import-contacts', { csv });
  assert.equal(first.data.summary.importados, 1);

  const second = await api('POST', '/api/campaigns/import-contacts', { csv });
  assert.equal(second.data.summary.importados, 0);
  assert.equal(second.data.summary.ya_importado, 1);
});

test('POST /api/campaigns/import-contacts rechaza archivo vacío', async () => {
  const res = await api('POST', '/api/campaigns/import-contacts', { csv: '' });
  assert.equal(res.status, 400);
});

test('POST /api/campaigns/import-contacts rechaza headers faltantes', async () => {
  const csv = ['telefono,otra_columna', '51944444444,algo'].join('\n');
  const res = await api('POST', '/api/campaigns/import-contacts', { csv });
  assert.equal(res.status, 400);
  assert.match(res.data.error, /nombre_o_referencia/);
});

test('POST /api/campaigns/import-contacts rechaza archivo sin filas de datos', async () => {
  const res = await api('POST', '/api/campaigns/import-contacts', { csv: 'telefono,nombre_o_referencia' });
  assert.equal(res.status, 400);
});

test('POST /api/campaigns/send con source=campaign_contacts registra campaign_contact_id, no client_id', async () => {
  // Teléfono de 8 dígitos: pasa la validación de import (isValidWhatsappPhone,
  // 8-15 dígitos) pero falla el regex estricto de envío (/^519\d{8}$/),
  // así que el endpoint de send falla en la rama "teléfono inválido" sin
  // necesidad de una llamada real a la API de Meta.
  const csv = ['telefono,nombre_o_referencia', '12345678,Prospecto Telefono Raro'].join('\n');
  const importRes = await api('POST', '/api/campaigns/import-contacts', { csv });
  const contactId = importRes.data.contacts[0].id;
  assert.equal(importRes.data.contacts[0].telefono, '12345678');

  const sendRes = await api('POST', '/api/campaigns/send', {
    template_name: 'plantilla_test',
    template_language: 'es',
    client_ids: [contactId],
    source: 'campaign_contacts',
  });
  assert.equal(sendRes.status, 200);
  assert.equal(sendRes.data.failed, 1);
  assert.equal(sendRes.data.results[0].error, 'Número de teléfono inválido o ausente.');

  const logRow = row(await db.execute({
    sql: 'SELECT client_id, campaign_contact_id, contact_source FROM campaign_logs WHERE campaign_id = ? LIMIT 1',
    args: [sendRes.data.campaign_id],
  }));
  assert.equal(logRow.client_id, null);
  assert.equal(logRow.campaign_contact_id, contactId);
  assert.equal(logRow.contact_source, 'campaign_contacts');
});

test('POST /api/campaigns/send con source=clients (default) registra client_id, no campaign_contact_id', async () => {
  const clientId = await createClient({ name: 'Cliente Telefono Raro', phone: '12345678' });

  const sendRes = await api('POST', '/api/campaigns/send', {
    template_name: 'plantilla_test',
    template_language: 'es',
    client_ids: [clientId],
  });
  assert.equal(sendRes.status, 200);
  assert.equal(sendRes.data.failed, 1);

  const logRow = row(await db.execute({
    sql: 'SELECT client_id, campaign_contact_id, contact_source FROM campaign_logs WHERE campaign_id = ? LIMIT 1',
    args: [sendRes.data.campaign_id],
  }));
  assert.equal(logRow.client_id, clientId);
  assert.equal(logRow.campaign_contact_id, null);
  assert.equal(logRow.contact_source, 'clients');
});

test('POST /api/campaigns/send construye el texto de variable con el fallback correcto para valores vacíos', async () => {
  const csv = ['telefono,nombre_o_referencia', '51966666666,Prospecto Fallback Test'].join('\n');
  const importRes = await api('POST', '/api/campaigns/import-contacts', { csv });
  const contactId = importRes.data.contacts[0].id;

  const originalFetch = global.fetch;
  let capturedBody = null;
  global.fetch = async (url, options) => {
    if (typeof url === 'string' && url.includes('graph.facebook.com')) {
      capturedBody = JSON.parse(options.body);
      return { ok: true, json: async () => ({ messages: [{ id: 'wamid.FAKE_TEST_ID' }] }) };
    }
    return originalFetch(url, options);
  };

  try {
    const sendRes = await api('POST', '/api/campaigns/send', {
      template_name: 'plantilla_test',
      template_language: 'es',
      client_ids: [contactId],
      source: 'campaign_contacts',
      variable_mapping: { '1': 'dias_sin_pedir' },
    });
    assert.equal(sendRes.status, 200);
    assert.equal(sendRes.data.sent, 1);
    const sentText = capturedBody.template.components[0].parameters[0].text;
    assert.equal(sentText, 'Sin historial');
    assert.notEqual(sentText, 'dias_sin_pedir');
  } finally {
    global.fetch = originalFetch;
  }
});
