/**
 * Pruebas de los nuevos criterios de orden de GET /api/clients:
 * sort=orders_desc (más pedidos primero) y sort=recent (pedido más reciente primero).
 * Corre contra una base SQLite temporal (no toca producción).
 *   Ejecutar: npm test
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const TMP_DB = path.join(os.tmpdir(), `lmtest_${Date.now()}_sort.db`);
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
    name, address: '', reference: '', zone: 'Otra', phone: '999000111',
    type: 'Residencial', business_type: '', preferred_balloon: '10kg',
    purchase_frequency: 'irregular', notes: '', is_vip: false,
  })).data.id;

const newOrder = async (clientId, orderDate) =>
  (await api('POST', '/api/orders', {
    client_id: clientId, payment_method: 'Efectivo', catalog_version: 0,
    order_date: orderDate,
    items: [{ product: 'Balón 10kg', quantity: 1, unit_price: 38 }],
  })).data.id;

test('sort=orders_desc ordena de más a menos pedidos', async () => {
  const few = await newClient('Pocos Pedidos');
  const many = await newClient('Muchos Pedidos');
  const none = await newClient('Sin Pedidos');
  await newOrder(few, '2026-01-01T10:00:00.000Z');
  await newOrder(many, '2026-01-01T10:00:00.000Z');
  await newOrder(many, '2026-01-05T10:00:00.000Z');
  await newOrder(many, '2026-01-10T10:00:00.000Z');

  const { data } = await api('GET', '/api/clients?sort=orders_desc');
  const ids = data.map(c => c.id);
  const posMany = ids.indexOf(many);
  const posFew  = ids.indexOf(few);
  const posNone = ids.indexOf(none);
  assert.ok(posMany < posFew, 'el cliente con más pedidos debe ir antes');
  assert.ok(posFew < posNone, 'el cliente con pedidos debe ir antes que el que no tiene');
});

test('sort=recent ordena por fecha de último pedido, el más reciente primero', async () => {
  const old = await newClient('Pedido Viejo');
  const recent = await newClient('Pedido Reciente');
  const none = await newClient('Sin Pedido Recent');
  await newOrder(old, '2026-01-01T10:00:00.000Z');
  await newOrder(recent, '2026-06-01T10:00:00.000Z');

  const { data } = await api('GET', '/api/clients?sort=recent');
  const ids = data.map(c => c.id);
  const posRecent = ids.indexOf(recent);
  const posOld    = ids.indexOf(old);
  const posNone   = ids.indexOf(none);
  assert.ok(posRecent < posOld, 'el pedido más reciente debe ir primero');
  assert.ok(posOld < posNone, 'los clientes sin pedidos deben ir al final con sort=recent');
});

test('sin sort mantiene el comportamiento default (más antiguo/sin pedidos primero)', async () => {
  const old = await newClient('Default Viejo');
  const recent = await newClient('Default Reciente');
  await newOrder(old, '2026-01-01T10:00:00.000Z');
  await newOrder(recent, '2026-06-01T10:00:00.000Z');

  const { data } = await api('GET', '/api/clients');
  const ids = data.map(c => c.id);
  assert.ok(ids.indexOf(old) < ids.indexOf(recent), 'default: más antiguo primero (para reactivación)');
});
