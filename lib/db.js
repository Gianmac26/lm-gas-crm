/**
 * Cliente de base de datos (Turso/libsql) y helpers compartidos.
 * Centraliza el acceso a la BD para que las rutas no recreen el cliente.
 */
const { createClient } = require('@libsql/client');

const db = createClient({
  url:       process.env.TURSO_DATABASE_URL || 'file:./database/lm_gas.db',
  authToken: process.env.TURSO_AUTH_TOKEN,
});

// Zona horaria del negocio: Perú (UTC-5, sin horario de verano).
// El servidor corre en UTC, así que restamos 5 h para obtener la fecha local.
const PERU_TZ_OFFSET = '-5 hours';

function todayStr() {
  return new Date(Date.now() - 5 * 3600 * 1000).toISOString().slice(0, 10);
}

function rows(result) { return result.rows; }
function row(result)  { return result.rows[0] ?? null; }
function lastId(result) { return Number(result.lastInsertRowid); }

function normalizePhone(value) {
  const digits = String(value || '').replace(/[+\s\-()]/g, '').replace(/\D/g, '');
  if (!digits) return '';
  if (/^9\d{8}$/.test(digits)) return `51${digits}`;
  if (/^51\d{9}$/.test(digits) && digits.length === 11) return digits;
  return digits;
}

function isoNow() {
  return new Date().toISOString();
}

function whatsappTimestamp(value) {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return isoNow();
  return new Date(n * 1000).toISOString();
}

async function tableColumns(tableName) {
  const result = await db.execute({ sql: `PRAGMA table_info(${tableName})`, args: [] });
  return new Set(rows(result).map(c => c.name));
}

async function ensureColumn(tableName, columnName, definition) {
  const columns = await tableColumns(tableName);
  if (!columns.has(columnName)) {
    await db.execute({ sql: `ALTER TABLE ${tableName} ADD COLUMN ${columnName} ${definition}`, args: [] });
  }
}

module.exports = {
  db,
  PERU_TZ_OFFSET,
  todayStr,
  rows,
  row,
  lastId,
  normalizePhone,
  isoNow,
  whatsappTimestamp,
  tableColumns,
  ensureColumn,
};
