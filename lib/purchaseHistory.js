/**
 * Lógica pura del Recibo Histórico de Compras: clasificación del tipo de
 * balón por ítem y cálculo de días de duración / promedio entre recompras
 * del mismo tipo. Sin acceso a base de datos, para poder testear aislado.
 */

// Mismos clasificadores usados en el resumen diario (server.js): snapshot primero, legacy como fallback.
function classifyBalloon(item) {
  const is10 = item.presentation_snapshot === '10 kg' || item.product === 'Balón 10kg';
  const is45 = item.presentation_snapshot === '45 kg' || item.product === 'Balón 40kg';
  if (is45) return '45kg';
  if (is10) return item.valve_type_snapshot === 'premium' ? '10kg Premium' : '10kg Normal';
  return null;
}

// dateLocal en formato 'YYYY-MM-DD' (fecha local del negocio, ya calculada por el caller).
function daysBetween(dateLocalA, dateLocalB) {
  const [ya, ma, da] = dateLocalA.split('-').map(Number);
  const [yb, mb, db] = dateLocalB.split('-').map(Number);
  const msA = Date.UTC(ya, ma - 1, da);
  const msB = Date.UTC(yb, mb - 1, db);
  return Math.round((msB - msA) / 86400000);
}

// records: [{ itemId, dateTime, dateLocal, type, ... }] -> agrega dias_duracion
// por registro y promedio_dias por tipo (null si hay menos de 2 compras de ese tipo).
function buildPurchaseHistory(records) {
  const sorted = [...records].sort((a, b) => {
    if (a.dateTime !== b.dateTime) return a.dateTime < b.dateTime ? -1 : 1;
    return (a.itemId ?? 0) - (b.itemId ?? 0);
  });

  const lastDateByType = {};
  const durationsByType = {};

  const history = sorted.map(r => {
    let dias_duracion = null;
    const prevDate = lastDateByType[r.type];
    if (prevDate !== undefined) {
      dias_duracion = daysBetween(prevDate, r.dateLocal);
      (durationsByType[r.type] ??= []).push(dias_duracion);
    } else {
      durationsByType[r.type] ??= [];
    }
    lastDateByType[r.type] = r.dateLocal;
    return { ...r, dias_duracion };
  });

  const averages = {};
  for (const [type, list] of Object.entries(durationsByType)) {
    averages[type] = list.length ? list.reduce((s, n) => s + n, 0) / list.length : null;
  }

  return { history, averages };
}

module.exports = { classifyBalloon, daysBetween, buildPurchaseHistory };
