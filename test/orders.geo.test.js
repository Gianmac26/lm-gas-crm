/**
 * Rastro de auditoría del motorizado: punto y hora de salida/cierre.
 * Regla de oro: el GPS NUNCA bloquea ni rompe una entrega.
 *   Ejecutar: npm test
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const TMP_DB = path.join(os.tmpdir(), `lmtest_geo_${Date.now()}.db`);
process.env.TURSO_DATABASE_URL = 'file:' + TMP_DB;
delete process.env.TURSO_AUTH_TOKEN;

const app = require('../server');
const { db, row } = require('../lib/db');

let base, server;

test.before(async () => {
  await new Promise(r => { server = app.listen(0, r); });
  base = `http://localhost:${server.address().port}`;
  await fetch(`${base}/api/config`); // dispara la creación de tablas + migraciones
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

async function newOrder(overrides = {}) {
  const { data } = await api('POST', '/api/orders', {
    client_id: null, rider_id: null, payment_method: 'Efectivo', status: 'Pendiente',
    items: [{ product: 'Balón 10kg', quantity: 1, unit_price: 50 }],
    ...overrides,
  });
  return data.id;
}
const getOrder = async (id) => row(await db.execute({ sql: 'SELECT * FROM orders WHERE id = ?', args: [id] }));

test('graba punto y hora de salida en "En camino" y de cierre en "Entregado"', async () => {
  const id = await newOrder();

  await api('PATCH', `/api/orders/${id}/status`, { status: 'En camino', lat: -12.1, lng: -77.0, accuracy: 12.5 });
  let o = await getOrder(id);
  assert.ok(o.departed_at, 'debe sellar la hora de salida');
  assert.equal(o.departed_lat, -12.1);
  assert.equal(o.departed_lng, -77.0);
  assert.equal(o.departed_accuracy, 12.5);
  assert.equal(o.closed_at, null, 'aún no cierra');

  await api('PATCH', `/api/orders/${id}/status`, { status: 'Entregado', lat: -12.2, lng: -77.1, accuracy: 80 });
  o = await getOrder(id);
  assert.ok(o.closed_at, 'debe sellar la hora de cierre');
  assert.equal(o.closed_lat, -12.2);
  assert.equal(o.closed_accuracy, 80);
  assert.equal(o.status, 'Entregado');
});

test('graba el punto de cierre también en "No entregado", junto al motivo', async () => {
  const id = await newOrder();
  await api('PATCH', `/api/orders/${id}/status`, { status: 'En camino', lat: -12.0, lng: -77.0, accuracy: 10 });
  await api('PATCH', `/api/orders/${id}/status`, { status: 'No entregado', reason: 'Cliente ausente', lat: -12.3, lng: -77.2, accuracy: 25 });

  const o = await getOrder(id);
  assert.equal(o.closed_lat, -12.3);
  assert.equal(o.non_delivery_reason, 'Cliente ausente');
});

test('sin GPS: la hora se graba igual y las coordenadas quedan nulas (nunca bloquea)', async () => {
  const id = await newOrder();

  const r1 = await api('PATCH', `/api/orders/${id}/status`, { status: 'En camino' });
  assert.equal(r1.status, 200, 'la falta de GPS no debe impedir salir');
  const r2 = await api('PATCH', `/api/orders/${id}/status`, { status: 'Entregado' });
  assert.equal(r2.status, 200, 'la falta de GPS no debe impedir entregar');

  const o = await getOrder(id);
  assert.ok(o.departed_at, 'la hora de salida se graba aunque no haya GPS');
  assert.ok(o.closed_at, 'la hora de cierre se graba aunque no haya GPS');
  assert.equal(o.departed_lat, null);
  assert.equal(o.closed_lat, null);
});

test('coordenadas inválidas degradan a "sin GPS" en vez de romper', async () => {
  const id = await newOrder();
  const res = await api('PATCH', `/api/orders/${id}/status`, { status: 'Entregado', lat: 'abc', lng: 999, accuracy: -3 });

  assert.equal(res.status, 200);
  const o = await getOrder(id);
  assert.equal(o.closed_lat, null);
  assert.equal(o.closed_lng, null);
  assert.ok(o.closed_at, 'la hora sí se graba');
});

test('"En camino" repetido no sobrescribe la salida original', async () => {
  const id = await newOrder();
  await api('PATCH', `/api/orders/${id}/status`, { status: 'En camino', lat: -12.0, lng: -77.0, accuracy: 5 });
  const first = await getOrder(id);

  await new Promise(r => setTimeout(r, 1100));
  await api('PATCH', `/api/orders/${id}/status`, { status: 'En camino', lat: -12.9, lng: -77.9, accuracy: 5 });
  const second = await getOrder(id);

  assert.equal(second.departed_at, first.departed_at, 'la primera salida es la real');
  assert.equal(second.departed_lat, -12.0, 'no debe pisar la coordenada original');
});

test('la geo no interfiere con la reversión de deuda de Crédito (misma transacción)', async () => {
  const { data: client } = await api('POST', '/api/clients', {
    name: 'Cliente Geo', address: '', reference: '', zone: 'Otra', phone: '51955555555',
    type: 'Residencial', business_type: '', preferred_balloon: '10kg',
    purchase_frequency: 'irregular', notes: '', is_vip: false,
  });
  const orderId = await newOrder({ client_id: client.id, payment_method: 'Crédito' });

  const before = (await api('GET', `/api/clients/${client.id}`)).data.debt;
  assert.equal(before, 50, 'el pedido a crédito generó deuda');

  await api('PATCH', `/api/orders/${orderId}/status`, { status: 'No entregado', reason: 'Rechazó', lat: -12.05, lng: -77.05, accuracy: 30 });

  const after = (await api('GET', `/api/clients/${client.id}`)).data.debt;
  assert.equal(after, 0, 'un pedido no entregado revierte la deuda');

  const o = await getOrder(orderId);
  assert.equal(o.closed_lat, -12.05, 'y además guardó el punto de cierre');
});
