/**
 * Pruebas de la bandeja de WhatsApp: tipo de último mensaje, cerrar/reabrir
 * conversación, auto-reapertura, y envío de plantilla 1 a 1.
 * Corre contra una base SQLite temporal (no toca producción).
 *   Ejecutar: npm test
 */
const test = require('node:test');
const assert = require('node:assert');
const crypto = require('node:crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');

const TMP_DB = path.join(os.tmpdir(), `lmtest_conversations_${Date.now()}.db`);
process.env.TURSO_DATABASE_URL = 'file:' + TMP_DB;
delete process.env.TURSO_AUTH_TOKEN;
delete process.env.WHATSAPP_ACCESS_TOKEN;
delete process.env.WHATSAPP_PHONE_NUMBER_ID;

const app = require('../server');

let base, server;
let waMessageCounter = 0;

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

async function sendInboundWhatsapp({ phone, contactName = 'Cliente Test', type = 'text', text = 'Hola' }) {
  waMessageCounter += 1;
  const message = {
    from: phone,
    id: `wamid.TEST${waMessageCounter}`,
    timestamp: String(Math.floor(Date.now() / 1000)),
    type,
  };
  if (type === 'text') message.text = { body: text };

  return api('POST', '/webhook/whatsapp', {
    entry: [{
      changes: [{
        value: {
          contacts: [{ wa_id: phone, profile: { name: contactName } }],
          messages: [message],
        },
      }],
    }],
  });
}

async function findConversationByPhone(phone) {
  const digits = phone.replace(/\D/g, '').slice(-9);
  const { data } = await api('GET', `/api/conversations?q=${digits}`);
  return data.conversations.find(c => c.phone_normalized === phone);
}

test('GET /api/conversations incluye last_message_type del último mensaje', async () => {
  const phone = '51911111111';
  await sendInboundWhatsapp({ phone, contactName: 'Multimedia Test', type: 'image' });
  const conv = await findConversationByPhone(phone);
  assert.ok(conv, 'debe existir la conversación');
  assert.equal(conv.last_message_type, 'image');
});
