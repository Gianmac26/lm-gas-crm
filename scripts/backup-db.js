#!/usr/bin/env node
/**
 * Respaldo de la base de datos Turso (lm-crm).
 *
 *   1. Genera un dump SQL portable con `turso db shell lm-crm ".dump"`.
 *   2. Lo restaura en una base temporal para comprobar que es válido.
 *   3. Compara los conteos de filas (en vivo vs respaldo) de las tablas clave.
 *   4. Conserva solo los últimos N respaldos.
 *
 * Uso:  node scripts/backup-db.js     (o:  npm run backup)
 * Requisitos: Turso CLI instalado y con sesión iniciada (`turso auth login`).
 *
 * Los respaldos se guardan en CRM-backups/ (carpeta ignorada por git porque
 * contiene datos personales de clientes — NO debe subirse a GitHub).
 */
const { execSync } = require('child_process');
const fs   = require('fs');
const os   = require('os');
const path = require('path');
const { createClient } = require('@libsql/client');

const DB     = process.env.TURSO_DB_NAME || 'lm-crm';
const DIR    = path.join(__dirname, '..', 'CRM-backups');
const KEEP   = parseInt(process.env.BACKUP_KEEP || '14', 10); // cuántos conservar
const TABLES = ['clients', 'orders', 'order_items', 'products', 'product_variants', 'payments'];

function sh(cmd) {
  return execSync(cmd, { maxBuffer: 1024 * 1024 * 128 }).toString();
}

function liveCount(table) {
  try {
    const out = sh(`turso db shell ${DB} "SELECT COUNT(*) FROM ${table}"`);
    const nums = out.match(/\d+/g) || [];
    return nums.length ? parseInt(nums[nums.length - 1], 10) : null;
  } catch { return null; } // tabla inexistente en esta base
}

(async () => {
  fs.mkdirSync(DIR, { recursive: true });
  const ts   = new Date().toISOString().replace(/:/g, '-').replace('T', '_').slice(0, 16);
  const file = path.join(DIR, `${DB}_${ts}.sql`);

  // 1) Dump
  console.log('1) Generando respaldo...');
  const dump = sh(`turso db shell ${DB} ".dump"`);
  if (!/CREATE TABLE/.test(dump) || !/INSERT INTO/.test(dump)) {
    throw new Error('El dump salió vacío o inválido — se aborta sin sobrescribir nada.');
  }
  fs.writeFileSync(file, dump);
  console.log(`   guardado: ${path.relative(process.cwd(), file)} (${(dump.length / 1024).toFixed(0)} KB)`);

  // 2) Restaurar en una base temporal
  console.log('2) Verificando que el respaldo se puede restaurar...');
  const tmp   = path.join(os.tmpdir(), `lmrestore_${Date.now()}.db`);
  const local = createClient({ url: 'file:' + tmp });
  await local.executeMultiple(dump);

  // 3) Comparar conteos
  console.log('3) Comparando conteos (en vivo vs respaldo)...');
  let ok = true;
  for (const t of TABLES) {
    const live = liveCount(t);
    if (live === null) continue;
    const restored = Number((await local.execute(`SELECT COUNT(*) c FROM ${t}`)).rows[0].c);
    const match = restored === live;
    if (!match) ok = false;
    console.log(`   ${match ? '✓' : '✗'} ${t}: vivo=${live} respaldo=${restored}`);
  }
  try { fs.unlinkSync(tmp); } catch {}

  // 4) Conservar solo los últimos KEEP
  const backups = fs.readdirSync(DIR).filter(f => f.endsWith('.sql')).sort();
  while (backups.length > KEEP) {
    const old = backups.shift();
    fs.unlinkSync(path.join(DIR, old));
    console.log(`   limpieza: eliminado respaldo viejo ${old}`);
  }

  console.log(ok
    ? '\n✅ Respaldo generado y verificado correctamente.'
    : '\n⚠️  Respaldo generado, pero los conteos NO coinciden. Revísalo antes de confiar en él.');
  process.exit(ok ? 0 : 1);
})().catch(e => { console.error('ERROR:', e.message); process.exit(1); });
