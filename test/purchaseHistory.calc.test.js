/**
 * Pruebas de la lógica pura de cálculo del recibo histórico de compras:
 * clasificación de tipo de balón, días de duración entre recompras y promedio.
 * No toca la base de datos.
 *   Ejecutar: npm test
 */
const test = require('node:test');
const assert = require('node:assert');
const { classifyBalloon, buildPurchaseHistory } = require('../lib/purchaseHistory');

test('classifyBalloon: 10kg con válvula normal', () => {
  assert.equal(classifyBalloon({ presentation_snapshot: '10 kg', valve_type_snapshot: 'normal' }), '10kg Normal');
});

test('classifyBalloon: 10kg con válvula premium', () => {
  assert.equal(classifyBalloon({ presentation_snapshot: '10 kg', valve_type_snapshot: 'premium' }), '10kg Premium');
});

test('classifyBalloon: 10kg legacy (product) sin valve_type_snapshot asume Normal', () => {
  assert.equal(classifyBalloon({ product: 'Balón 10kg' }), '10kg Normal');
});

test('classifyBalloon: 45kg por presentation_snapshot', () => {
  assert.equal(classifyBalloon({ presentation_snapshot: '45 kg', valve_type_snapshot: null }), '45kg');
});

test('classifyBalloon: 45kg legacy por product "Balón 40kg"', () => {
  assert.equal(classifyBalloon({ product: 'Balón 40kg' }), '45kg');
});

test('classifyBalloon: ítem que no es balón devuelve null', () => {
  assert.equal(classifyBalloon({ product: 'Kit de accesorios', category_snapshot: 'kit' }), null);
});

test('buildPurchaseHistory: una sola compra de un tipo -> dias_duracion null y promedio null', () => {
  const { history, averages } = buildPurchaseHistory([
    { itemId: 1, dateTime: '2026-05-02T10:00:00.000Z', dateLocal: '2026-05-02', type: '10kg Normal' },
  ]);
  assert.equal(history.length, 1);
  assert.equal(history[0].dias_duracion, null);
  assert.equal(averages['10kg Normal'], null);
});

test('buildPurchaseHistory: segunda compra calcula días desde la anterior del mismo tipo', () => {
  const { history, averages } = buildPurchaseHistory([
    { itemId: 1, dateTime: '2026-05-02T10:00:00.000Z', dateLocal: '2026-05-02', type: '10kg Normal' },
    { itemId: 2, dateTime: '2026-05-21T10:00:00.000Z', dateLocal: '2026-05-21', type: '10kg Normal' },
  ]);
  assert.equal(history[0].dias_duracion, null);
  assert.equal(history[1].dias_duracion, 19);
  assert.equal(averages['10kg Normal'], 19);
});

test('buildPurchaseHistory: tipos distintos no se mezclan en el cálculo de duración', () => {
  const { history, averages } = buildPurchaseHistory([
    { itemId: 1, dateTime: '2026-05-02T10:00:00.000Z', dateLocal: '2026-05-02', type: '10kg Normal' },
    { itemId: 2, dateTime: '2026-05-10T10:00:00.000Z', dateLocal: '2026-05-10', type: '45kg' },
    { itemId: 3, dateTime: '2026-05-21T10:00:00.000Z', dateLocal: '2026-05-21', type: '10kg Normal' },
  ]);
  const normalRows = history.filter(h => h.type === '10kg Normal');
  const balloon45Rows = history.filter(h => h.type === '45kg');
  assert.equal(normalRows[0].dias_duracion, null);
  assert.equal(normalRows[1].dias_duracion, 19);
  assert.equal(balloon45Rows[0].dias_duracion, null);
  assert.equal(averages['45kg'], null);
  assert.equal(averages['10kg Normal'], 19);
});

test('buildPurchaseHistory: dos compras el mismo día -> dias_duracion 0', () => {
  const { history, averages } = buildPurchaseHistory([
    { itemId: 1, dateTime: '2026-05-02T09:00:00.000Z', dateLocal: '2026-05-02', type: '45kg' },
    { itemId: 2, dateTime: '2026-05-02T18:00:00.000Z', dateLocal: '2026-05-02', type: '45kg' },
  ]);
  assert.equal(history[1].dias_duracion, 0);
  assert.equal(averages['45kg'], 0);
});

test('buildPurchaseHistory: promedio es el promedio de todas las duraciones del tipo', () => {
  const { averages } = buildPurchaseHistory([
    { itemId: 1, dateTime: '2026-01-01T00:00:00.000Z', dateLocal: '2026-01-01', type: '10kg Premium' },
    { itemId: 2, dateTime: '2026-01-11T00:00:00.000Z', dateLocal: '2026-01-11', type: '10kg Premium' },
    { itemId: 3, dateTime: '2026-01-31T00:00:00.000Z', dateLocal: '2026-01-31', type: '10kg Premium' },
  ]);
  // duraciones: 10 y 20 -> promedio 15
  assert.equal(averages['10kg Premium'], 15);
});

test('buildPurchaseHistory: ordena internamente aunque los registros lleguen desordenados', () => {
  const { history } = buildPurchaseHistory([
    { itemId: 2, dateTime: '2026-05-21T10:00:00.000Z', dateLocal: '2026-05-21', type: '10kg Normal' },
    { itemId: 1, dateTime: '2026-05-02T10:00:00.000Z', dateLocal: '2026-05-02', type: '10kg Normal' },
  ]);
  assert.equal(history[0].itemId, 1);
  assert.equal(history[0].dias_duracion, null);
  assert.equal(history[1].itemId, 2);
  assert.equal(history[1].dias_duracion, 19);
});
