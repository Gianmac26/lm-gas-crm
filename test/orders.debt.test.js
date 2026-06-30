/**
 * Pruebas de la lógica crítica de dinero: deuda del cliente y total del pedido.
 * Corre contra una base SQLite temporal (no toca producción).
 *   Ejecutar: npm test
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

// IMPORTANTE: apuntar a una base temporal ANTES de cargar el servidor.
const TMP_DB = path.join(os.tmpdir(), `lmtest_${Date.now()}.db`);
process.env.TURSO_DATABASE_URL = 'file:' + TMP_DB;
delete process.env.TURSO_AUTH_TOKEN;

const app = require('../server');

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

const newClient = async (name) =>
  (await api('POST', '/api/clients', {
    name, address: '', reference: '', zone: 'Otra', phone: '999000111',
    type: 'Residencial', business_type: '', preferred_balloon: '10kg',
    purchase_frequency: 'irregular', notes: '', is_vip: false,
  })).data.id;
const debtOf = async (id) => (await api('GET', `/api/clients/${id}`)).data.debt || 0;
const items = (qty, price, product = 'Balón 10kg') => [{ product, quantity: qty, unit_price: price }];

test('pedido Crédito suma a la deuda del cliente', async () => {
  const cid = await newClient('Crédito');
  assert.equal(await debtOf(cid), 0);
  const { data } = await api('POST', '/api/orders', { client_id: cid, payment_method: 'Crédito', catalog_version: 0, items: items(2, 40) });
  assert.ok(data.id, 'debe crear el pedido');
  assert.equal(await debtOf(cid), 80);
});

test('pedido Efectivo NO suma a la deuda', async () => {
  const cid = await newClient('Efectivo');
  await api('POST', '/api/orders', { client_id: cid, payment_method: 'Efectivo', catalog_version: 0, items: items(3, 38) });
  assert.equal(await debtOf(cid), 0);
});

test('editar Efectivo→Crédito sube la deuda y Crédito→Efectivo la baja', async () => {
  const cid = await newClient('Edit');
  const oid = (await api('POST', '/api/orders', { client_id: cid, payment_method: 'Efectivo', catalog_version: 0, items: items(1, 50) })).data.id;
  assert.equal(await debtOf(cid), 0);
  await api('PUT', `/api/orders/${oid}`, { payment_method: 'Crédito', catalog_version: 0, items: items(1, 50) });
  assert.equal(await debtOf(cid), 50);
  await api('PUT', `/api/orders/${oid}`, { payment_method: 'Efectivo', catalog_version: 0, items: items(1, 50) });
  assert.equal(await debtOf(cid), 0);
});

test('cancelar pedido Crédito revierte la deuda', async () => {
  const cid = await newClient('Cancel');
  const oid = (await api('POST', '/api/orders', { client_id: cid, payment_method: 'Crédito', catalog_version: 0, items: items(2, 30) })).data.id;
  assert.equal(await debtOf(cid), 60);
  await api('PATCH', `/api/orders/${oid}/status`, { status: 'Cancelado' });
  assert.equal(await debtOf(cid), 0);
});

test('eliminar pedido Crédito revierte la deuda (cascada)', async () => {
  const cid = await newClient('Delete');
  const oid = (await api('POST', '/api/orders', { client_id: cid, payment_method: 'Crédito', catalog_version: 0, items: items(2, 25) })).data.id;
  assert.equal(await debtOf(cid), 50);
  await api('DELETE', `/api/orders/${oid}`);
  assert.equal(await debtOf(cid), 0);
});

test('el total del pedido = suma de subtotales de los ítems', async () => {
  const cid = await newClient('Total');
  const oid = (await api('POST', '/api/orders', {
    client_id: cid, payment_method: 'Efectivo', catalog_version: 0,
    items: [{ product: 'Balón 10kg', quantity: 2, unit_price: 40 }, { product: 'Balón 40kg', quantity: 1, unit_price: 120 }],
  })).data.id;
  const order = (await api('GET', `/api/orders/${oid}`)).data;
  assert.equal(order.total, 200);
});

test('order_date retroactivo guarda el pedido en esa fecha', async () => {
  const cid = await newClient('Fecha');
  const oid = (await api('POST', '/api/orders', {
    client_id: cid, payment_method: 'Efectivo', catalog_version: 0,
    order_date: '2026-06-10T15:00:00.000Z', items: items(1, 38),
  })).data.id;
  const order = (await api('GET', `/api/orders/${oid}`)).data;
  assert.ok(String(order.created_at).startsWith('2026-06-10'), `created_at fue ${order.created_at}`);
});
