/**
 * Prueba de integración del endpoint del recibo histórico de compras.
 * Corre contra una base SQLite temporal (no toca producción).
 *   Ejecutar: npm test
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const TMP_DB = path.join(os.tmpdir(), `lmtest_${Date.now()}_ph.db`);
process.env.TURSO_DATABASE_URL = 'file:' + TMP_DB;
delete process.env.TURSO_AUTH_TOKEN;

const app = require('../server');

let base, server;

test.before(async () => {
  await new Promise(r => { server = app.listen(0, r); });
  base = `http://localhost:${server.address().port}`;
  await fetch(`${base}/api/config`);
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

const newClient = async (name) =>
  (await api('POST', '/api/clients', {
    name, address: 'Jr. Test 123', reference: '', zone: 'Otra', phone: '999000111',
    type: 'Residencial', business_type: '', preferred_balloon: '10kg',
    purchase_frequency: 'irregular', notes: '', is_vip: false,
  })).data.id;

test('GET /api/clients/:id/purchase-history arma historial con dias_duracion y promedio, excluye cancelados', async () => {
  const cid = await newClient('Historial');
  await api('POST', '/api/orders', {
    client_id: cid, payment_method: 'Efectivo', catalog_version: 0,
    order_date: '2026-05-02T10:00:00.000Z',
    items: [{ product: 'Balón 10kg', quantity: 1, unit_price: 45 }],
  });
  await api('POST', '/api/orders', {
    client_id: cid, payment_method: 'Efectivo', catalog_version: 0,
    order_date: '2026-05-21T10:00:00.000Z',
    items: [{ product: 'Balón 10kg', quantity: 1, unit_price: 45 }],
  });
  const cancelled = (await api('POST', '/api/orders', {
    client_id: cid, payment_method: 'Efectivo', catalog_version: 0,
    order_date: '2026-05-15T10:00:00.000Z',
    items: [{ product: 'Balón 10kg', quantity: 1, unit_price: 45 }],
  })).data.id;
  await api('PATCH', `/api/orders/${cancelled}/status`, { status: 'Cancelado' });

  const { status, data } = await api('GET', `/api/clients/${cid}/purchase-history`);
  assert.equal(status, 200);
  assert.equal(data.client.name, 'Historial');
  assert.equal(data.history.length, 2, 'el pedido cancelado no debe contarse');
  assert.equal(data.history[0].type, '10kg Normal');
  assert.equal(data.history[0].dias_duracion, null);
  assert.equal(data.history[1].dias_duracion, 19);
  assert.equal(data.history[1].price, 45);
  assert.equal(data.averages['10kg Normal'], 19);
});

test('GET /api/clients/:id/purchase-history con cliente sin pedidos devuelve historial vacío', async () => {
  const cid = await newClient('Sin pedidos');
  const { status, data } = await api('GET', `/api/clients/${cid}/purchase-history`);
  assert.equal(status, 200);
  assert.deepEqual(data.history, []);
  assert.deepEqual(data.averages, {});
});

test('GET /api/clients/:id/purchase-history con cliente inexistente devuelve 404', async () => {
  const { status } = await api('GET', '/api/clients/999999/purchase-history');
  assert.equal(status, 404);
});
