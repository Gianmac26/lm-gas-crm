const express = require('express');
const { createClient } = require('@libsql/client');
const cors = require('cors');
const ExcelJS = require('exceljs');

const app = express();
const DEFAULT_WHATSAPP_API_VERSION = 'v20.0';
const WHATSAPP_SEND_TIMEOUT_MS = 10000;
const MAX_WHATSAPP_TEXT_LENGTH = 4096;

const db = createClient({
  url:       process.env.TURSO_DATABASE_URL || 'file:./database/lm_gas.db',
  authToken: process.env.TURSO_AUTH_TOKEN,
});

app.use(cors());
app.use(express.json());

// ─── DB INIT (lazy, runs once before first request) ───────────────────────────
let _initPromise = null;

async function initDb() {
  await db.batch([
    { sql: `CREATE TABLE IF NOT EXISTS config (key TEXT PRIMARY KEY, value TEXT)`, args: [] },
    { sql: `CREATE TABLE IF NOT EXISTS clients (
              id                 INTEGER PRIMARY KEY AUTOINCREMENT,
              name               TEXT NOT NULL,
              address            TEXT,
              reference          TEXT,
              zone               TEXT DEFAULT 'Otra',
              phone              TEXT,
              type               TEXT DEFAULT 'Residencial',
              business_type      TEXT,
              preferred_balloon  TEXT DEFAULT '10kg',
              purchase_frequency TEXT DEFAULT 'irregular',
              notes              TEXT,
              debt               REAL DEFAULT 0,
              is_vip             INTEGER DEFAULT 0,
              created_at         DATETIME DEFAULT CURRENT_TIMESTAMP,
              phone_normalized   TEXT,
              last_whatsapp_at   DATETIME,
              wa_opt_in          INTEGER DEFAULT 0,
              wa_opt_in_at       DATETIME,
              wa_opt_in_source   TEXT,
              wa_marketing_opt_out_at DATETIME
            )`, args: [] },
    { sql: `CREATE TABLE IF NOT EXISTS riders (
              id     INTEGER PRIMARY KEY AUTOINCREMENT,
              name   TEXT NOT NULL,
              phone  TEXT,
              zone   TEXT,
              active INTEGER DEFAULT 1
            )`, args: [] },
    { sql: `CREATE TABLE IF NOT EXISTS orders (
              id             INTEGER PRIMARY KEY AUTOINCREMENT,
              client_id      INTEGER,
              rider_id       INTEGER,
              status         TEXT DEFAULT 'Pendiente',
              payment_method TEXT DEFAULT 'Efectivo',
              total          REAL DEFAULT 0,
              notes          TEXT,
              created_at     DATETIME DEFAULT CURRENT_TIMESTAMP,
              delivered_at   DATETIME,
              FOREIGN KEY (client_id) REFERENCES clients(id),
              FOREIGN KEY (rider_id)  REFERENCES riders(id)
            )`, args: [] },
    { sql: `CREATE TABLE IF NOT EXISTS order_items (
              id          INTEGER PRIMARY KEY AUTOINCREMENT,
              order_id    INTEGER,
              product     TEXT,
              description TEXT,
              quantity    INTEGER DEFAULT 1,
              unit_price  REAL DEFAULT 0,
              subtotal    REAL DEFAULT 0,
              FOREIGN KEY (order_id) REFERENCES orders(id)
            )`, args: [] },
    { sql: `CREATE TABLE IF NOT EXISTS wa_conversations (
              id               INTEGER PRIMARY KEY AUTOINCREMENT,
              client_id        INTEGER,
              phone            TEXT,
              phone_normalized TEXT NOT NULL,
              contact_name     TEXT,
              status           TEXT DEFAULT 'open',
              assigned_to      TEXT,
              last_message_at  DATETIME,
              last_inbound_at  DATETIME,
              unread_count     INTEGER DEFAULT 0,
              created_at       DATETIME DEFAULT CURRENT_TIMESTAMP,
              updated_at       DATETIME DEFAULT CURRENT_TIMESTAMP,
              FOREIGN KEY (client_id) REFERENCES clients(id)
            )`, args: [] },
    { sql: `CREATE TABLE IF NOT EXISTS wa_messages (
              id               INTEGER PRIMARY KEY AUTOINCREMENT,
              conversation_id  INTEGER,
              client_id        INTEGER,
              phone            TEXT,
              phone_normalized TEXT,
              message          TEXT,
              body             TEXT,
              direction        TEXT DEFAULT 'inbound',
              type             TEXT DEFAULT 'text',
              client_request_id TEXT,
              wa_message_id    TEXT,
              status           TEXT DEFAULT 'received',
              error_code       TEXT,
              error_message    TEXT,
              raw_payload      TEXT,
              sent_at          DATETIME,
              delivered_at     DATETIME,
              read_at          DATETIME,
              received_at      DATETIME DEFAULT CURRENT_TIMESTAMP,
              created_at       DATETIME DEFAULT CURRENT_TIMESTAMP,
              FOREIGN KEY (conversation_id) REFERENCES wa_conversations(id),
              FOREIGN KEY (client_id) REFERENCES clients(id)
            )`, args: [] },
  ], 'write');

  await migrateWhatsappSchema();
  await migratePaymentsSchema();
  await migrateCatalogSchema();

  const defaults = {
    pin: '1234', daily_goal: '80', price_10kg: '38', price_40kg: '120',
    price_water: '12', price_cleaning: '15',
    zones: 'San Borja,Surco,Miraflores,San Luis,San Isidro,Otra', dark_mode: 'false',
  };
  await Promise.all(
    Object.entries(defaults).map(([k, v]) =>
      db.execute({ sql: 'INSERT OR IGNORE INTO config (key, value) VALUES (?, ?)', args: [k, v] })
    )
  );

  // Asegurar que las zonas incluyan San Luis y San Isidro (preserva las existentes
  // e inserta antes de "Otra"). Idempotente: solo agrega las que falten.
  const zc = row(await db.execute({ sql: `SELECT value FROM config WHERE key='zones'`, args: [] }));
  if (zc) {
    const list = String(zc.value || '').split(',').map(s => s.trim()).filter(Boolean);
    let changed = false;
    for (const d of ['San Luis', 'San Isidro']) {
      if (!list.includes(d)) {
        const oi = list.indexOf('Otra');
        if (oi === -1) list.push(d); else list.splice(oi, 0, d);
        changed = true;
      }
    }
    if (changed) await db.execute({ sql: `UPDATE config SET value=? WHERE key='zones'`, args: [list.join(',')] });
  }
}

// Ensure DB is ready before every request
app.use(async (req, res, next) => {
  try {
    if (!_initPromise) _initPromise = initDb();
    await _initPromise;
    next();
  } catch (err) {
    _initPromise = null; // allow retry on next request
    next(err);
  }
});

// ─── HELPERS ──────────────────────────────────────────────────────────────────
async function getConfig() {
  const result = await db.execute({ sql: 'SELECT key, value FROM config', args: [] });
  return Object.fromEntries(result.rows.map(r => [r.key, r.value]));
}

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

async function migrateWhatsappSchema() {
  const clientColumns = [
    ['phone_normalized', 'TEXT'],
    ['last_whatsapp_at', 'DATETIME'],
    ['wa_opt_in', 'INTEGER DEFAULT 0'],
    ['wa_opt_in_at', 'DATETIME'],
    ['wa_opt_in_source', 'TEXT'],
    ['wa_marketing_opt_out_at', 'DATETIME'],
  ];

  const conversationColumns = [
    ['client_id', 'INTEGER'],
    ['phone', 'TEXT'],
    ['phone_normalized', 'TEXT'],
    ['contact_name', 'TEXT'],
    ['status', `TEXT DEFAULT 'open'`],
    ['assigned_to', 'TEXT'],
    ['last_message_at', 'DATETIME'],
    ['last_inbound_at', 'DATETIME'],
    ['unread_count', 'INTEGER DEFAULT 0'],
    ['created_at', 'DATETIME'],
    ['updated_at', 'DATETIME'],
  ];

  const messageColumns = [
    ['conversation_id', 'INTEGER'],
    ['phone_normalized', 'TEXT'],
    ['body', 'TEXT'],
    ['direction', `TEXT DEFAULT 'inbound'`],
    ['type', `TEXT DEFAULT 'text'`],
    ['client_request_id', 'TEXT'],
    ['wa_message_id', 'TEXT'],
    ['status', `TEXT DEFAULT 'received'`],
    ['error_code', 'TEXT'],
    ['error_message', 'TEXT'],
    ['raw_payload', 'TEXT'],
    ['sent_at', 'DATETIME'],
    ['delivered_at', 'DATETIME'],
    ['read_at', 'DATETIME'],
    ['created_at', 'DATETIME'],
  ];

  for (const [name, definition] of clientColumns) {
    await ensureColumn('clients', name, definition);
  }
  for (const [name, definition] of conversationColumns) {
    await ensureColumn('wa_conversations', name, definition);
  }
  for (const [name, definition] of messageColumns) {
    await ensureColumn('wa_messages', name, definition);
  }

  await backfillClientPhones();
  await backfillConversationPhones();
  await dedupeConversationsByPhone();

  await db.execute({
    sql: 'CREATE UNIQUE INDEX IF NOT EXISTS idx_wa_conversations_phone_normalized ON wa_conversations(phone_normalized)',
    args: [],
  });
  await db.execute({
    sql: 'CREATE UNIQUE INDEX IF NOT EXISTS idx_wa_messages_wa_message_id ON wa_messages(wa_message_id)',
    args: [],
  });
  await db.execute({
    sql: 'CREATE UNIQUE INDEX IF NOT EXISTS idx_wa_messages_client_request_id ON wa_messages(client_request_id)',
    args: [],
  });
  await db.execute({
    sql: 'CREATE INDEX IF NOT EXISTS idx_wa_messages_conversation_created ON wa_messages(conversation_id, created_at)',
    args: [],
  });
  await db.execute({
    sql: 'CREATE INDEX IF NOT EXISTS idx_clients_phone_normalized ON clients(phone_normalized)',
    args: [],
  });

  await migrateLegacyWhatsappMessages();
  await rebuildConversationSummaries();
}

async function migratePaymentsSchema() {
  await db.execute({
    sql: `CREATE TABLE IF NOT EXISTS payments (
      id                INTEGER PRIMARY KEY AUTOINCREMENT,
      order_id          INTEGER NOT NULL,
      amount            REAL NOT NULL,
      method            TEXT NOT NULL,
      destination       TEXT NOT NULL,
      operation_number  TEXT,
      status            TEXT NOT NULL DEFAULT 'reportado',
      reported_by       TEXT,
      reported_at       DATETIME DEFAULT CURRENT_TIMESTAMP,
      confirmed_by      TEXT,
      confirmed_at      DATETIME,
      rejection_reason  TEXT,
      notes             TEXT,
      client_request_id TEXT,
      created_at        DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at        DATETIME DEFAULT CURRENT_TIMESTAMP
    )`,
    args: [],
  });
  await db.execute({
    sql: `CREATE UNIQUE INDEX IF NOT EXISTS idx_payments_order_id ON payments(order_id)`,
    args: [],
  });
  await db.execute({
    sql: `CREATE UNIQUE INDEX IF NOT EXISTS idx_payments_client_request_id ON payments(client_request_id) WHERE client_request_id IS NOT NULL`,
    args: [],
  });

  await db.execute({
    sql: `CREATE TABLE IF NOT EXISTS cash_handovers (
      id           INTEGER PRIMARY KEY AUTOINCREMENT,
      payment_id   INTEGER NOT NULL,
      rider_id     INTEGER NOT NULL,
      amount       REAL NOT NULL,
      status       TEXT NOT NULL DEFAULT 'en_poder_motorizado',
      handed_to    TEXT,
      handed_by    TEXT,
      handed_at    DATETIME,
      confirmed_by TEXT,
      confirmed_at DATETIME,
      notes        TEXT,
      created_at   DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at   DATETIME DEFAULT CURRENT_TIMESTAMP
    )`,
    args: [],
  });
  await db.execute({
    sql: `CREATE UNIQUE INDEX IF NOT EXISTS idx_cash_handovers_payment_id ON cash_handovers(payment_id)`,
    args: [],
  });

  await db.execute({
    sql: `CREATE TABLE IF NOT EXISTS payment_events (
      id               INTEGER PRIMARY KEY AUTOINCREMENT,
      payment_id       INTEGER NOT NULL,
      cash_handover_id INTEGER,
      event_type       TEXT NOT NULL,
      previous_status  TEXT,
      new_status       TEXT,
      performed_by     TEXT,
      notes            TEXT,
      created_at       DATETIME DEFAULT CURRENT_TIMESTAMP
    )`,
    args: [],
  });
  await db.execute({
    sql: `CREATE INDEX IF NOT EXISTS idx_payment_events_payment_id ON payment_events(payment_id)`,
    args: [],
  });

  // "Fiado" fue renombrado a "Crédito" como forma de pago. Normaliza pedidos
  // existentes para que el método se muestre consistente (idempotente).
  await db.execute({
    sql: `UPDATE orders SET payment_method = 'Crédito' WHERE payment_method = 'Fiado'`,
    args: [],
  });
}

async function migrateCatalogSchema() {
  // ── New tables ─────────────────────────────────────────────────────────────
  await db.execute({
    sql: `CREATE TABLE IF NOT EXISTS products (
      id               INTEGER PRIMARY KEY AUTOINCREMENT,
      name             TEXT NOT NULL,
      category         TEXT NOT NULL DEFAULT 'otro',
      description      TEXT,
      sku              TEXT UNIQUE,
      sale_price       REAL DEFAULT 0,
      unit             TEXT DEFAULT 'unidad',
      tracks_inventory INTEGER DEFAULT 0,
      active           INTEGER DEFAULT 1,
      created_at       DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at       DATETIME DEFAULT CURRENT_TIMESTAMP
    )`,
    args: [],
  });

  await db.execute({
    sql: `CREATE TABLE IF NOT EXISTS product_variants (
      id               INTEGER PRIMARY KEY AUTOINCREMENT,
      product_id       INTEGER NOT NULL,
      brand            TEXT,
      presentation_kg  REAL,
      valve_type       TEXT,
      sku              TEXT UNIQUE,
      sale_price       REAL,
      active           INTEGER DEFAULT 1,
      created_at       DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at       DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (product_id) REFERENCES products(id)
    )`,
    args: [],
  });

  await db.execute({
    sql: `CREATE TABLE IF NOT EXISTS inventory_stock (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      product_id  INTEGER NOT NULL,
      variant_id  INTEGER,
      stock_type  TEXT NOT NULL DEFAULT 'disponible',
      quantity    INTEGER DEFAULT 0,
      updated_at  DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (product_id) REFERENCES products(id),
      FOREIGN KEY (variant_id) REFERENCES product_variants(id)
    )`,
    args: [],
  });
  await db.execute({
    sql: `CREATE INDEX IF NOT EXISTS idx_inventory_stock_product ON inventory_stock(product_id)`,
    args: [],
  });
  // H3: consolidate any pre-existing duplicate stock rows, then enforce uniqueness.
  // COALESCE(variant_id, -1) lets the index treat NULL as -1 for equality (SQLite NULL != NULL in indexes).
  await db.execute({
    sql: `DELETE FROM inventory_stock WHERE id NOT IN (
            SELECT MAX(id) FROM inventory_stock
            GROUP BY product_id, stock_type, COALESCE(variant_id, -1)
          )`,
    args: [],
  });
  await db.execute({
    sql: `CREATE UNIQUE INDEX IF NOT EXISTS idx_inventory_stock_unique
          ON inventory_stock(product_id, stock_type, COALESCE(variant_id, -1))`,
    args: [],
  });

  await db.execute({
    sql: `CREATE TABLE IF NOT EXISTS inventory_movements (
      id             INTEGER PRIMARY KEY AUTOINCREMENT,
      product_id     INTEGER NOT NULL,
      variant_id     INTEGER,
      movement_type  TEXT NOT NULL,
      quantity       INTEGER NOT NULL,
      stock_before   INTEGER,
      stock_after    INTEGER,
      order_id       INTEGER,
      rider_id       INTEGER,
      performed_by   TEXT,
      notes          TEXT,
      created_at     DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (product_id) REFERENCES products(id)
    )`,
    args: [],
  });
  await db.execute({
    sql: `CREATE INDEX IF NOT EXISTS idx_inventory_movements_product ON inventory_movements(product_id)`,
    args: [],
  });
  await db.execute({
    sql: `CREATE INDEX IF NOT EXISTS idx_inventory_movements_variant ON inventory_movements(variant_id)`,
    args: [],
  });

  // ── Extend existing tables ─────────────────────────────────────────────────
  await ensureColumn('orders', 'catalog_version', 'INTEGER DEFAULT 0');

  for (const [col, def] of [
    ['product_id',            'INTEGER'],
    ['variant_id',            'INTEGER'],
    ['product_name_snapshot', 'TEXT'],
    ['category_snapshot',     'TEXT'],
    ['brand_snapshot',        'TEXT'],
    ['presentation_snapshot', 'TEXT'],
    ['valve_type_snapshot',   'TEXT'],
    ['catalog_unit_price',    'REAL'],
  ]) {
    await ensureColumn('order_items', col, def);
  }

  // ── price_45kg in config (legacy price_40kg was the 45 kg price) ──────────
  await db.execute({
    sql: `INSERT OR IGNORE INTO config (key, value)
          SELECT 'price_45kg', value FROM config WHERE key = 'price_40kg'`,
    args: [],
  });
  await db.execute({
    sql: `INSERT OR IGNORE INTO config (key, value) VALUES ('price_45kg', '120')`,
    args: [],
  });

  // ── Seed catalog only once ─────────────────────────────────────────────────
  const cnt = row(await db.execute({ sql: 'SELECT COUNT(*) as c FROM products', args: [] }));
  if (!cnt || cnt.c === 0) await seedCatalog();

  // ── Reconcile catalog categories for installs seeded with the old layout ────
  // (idempotent: only the first run touches rows; later runs are no-ops)
  await reconcileCatalogCategories();
}

// Older installs seeded "válvula" as its own category plus a placeholder "Kit
// completo de válvula". The product structure is now: Balón / Kit de válvula
// (Válvula Normal + Premium) / Productos (accesorios). This moves legacy data
// into that shape without clobbering user edits.
async function reconcileCatalogCategories() {
  const now = isoNow();
  // 1. Válvula products now live under the "kit" category (Kit de válvula)
  await db.execute({ sql: `UPDATE products SET category='kit', updated_at=? WHERE category='válvula'`, args: [now] });
  // 2. Normalise legacy names
  await db.execute({ sql: `UPDATE products SET name='Válvula Normal',  updated_at=? WHERE name='Válvula normal'`,  args: [now] });
  await db.execute({ sql: `UPDATE products SET name='Válvula Premium', updated_at=? WHERE name='Válvula premium'`, args: [now] });
  await db.execute({ sql: `UPDATE products SET name='Producto de limpieza', updated_at=? WHERE name='Artículo limpieza'`, args: [now] });
  // 3. Drop the unused placeholder kit product (only if never used in an order)
  const placeholder = row(await db.execute({
    sql: `SELECT id FROM products WHERE name='Kit completo de válvula' LIMIT 1`, args: [],
  }));
  if (placeholder) {
    const ref = row(await db.execute({
      sql: `SELECT COUNT(*) as c FROM order_items WHERE product_id = ?`, args: [placeholder.id],
    }));
    if (!ref || ref.c === 0) {
      await db.execute({ sql: `DELETE FROM product_variants WHERE product_id = ?`, args: [placeholder.id] });
      await db.execute({ sql: `DELETE FROM products WHERE id = ?`, args: [placeholder.id] });
    }
  }

  // 4. Renombrar la marca "Otra marca" → "Otros" (variantes e historial de pedidos)
  await db.execute({ sql: `UPDATE product_variants SET brand='Otros', updated_at=? WHERE brand='Otra marca'`, args: [now] });
  await db.execute({ sql: `UPDATE order_items SET brand_snapshot='Otros' WHERE brand_snapshot='Otra marca'`, args: [] });
  await db.execute({ sql: `UPDATE order_items SET product_name_snapshot=REPLACE(product_name_snapshot,'Otra marca','Otros') WHERE product_name_snapshot LIKE '%Otra marca%'`, args: [] });

  // 5. (Una sola vez) activar el balón de 45 kg en todas las marcas al precio
  //    configurado, para que cada marca ofrezca 10 kg y 45 kg. El dueño puede
  //    ajustar precios o desactivar variantes después en el Catálogo.
  const flag = row(await db.execute({ sql: `SELECT value FROM config WHERE key='catalog_45kg_activated'`, args: [] }));
  if (!flag) {
    const cfg = await getConfig();
    const p45 = parseFloat(cfg.price_45kg || cfg.price_40kg || '120');
    await db.execute({
      sql: `UPDATE product_variants SET sale_price=?, active=1, updated_at=?
            WHERE presentation_kg=45 AND (sale_price IS NULL OR sale_price<=0)`,
      args: [p45, now],
    });
    await db.execute({ sql: `INSERT OR IGNORE INTO config (key, value) VALUES ('catalog_45kg_activated','1')`, args: [] });
  }
}

async function seedCatalog() {
  const cfg = await getConfig();
  const p10  = parseFloat(cfg.price_10kg  || '38');
  const p45  = parseFloat(cfg.price_45kg  || cfg.price_40kg || '120');
  const pWat = parseFloat(cfg.price_water || '12');
  const pCln = parseFloat(cfg.price_cleaning || '15');
  const now  = isoNow();

  const insProduct = async (name, category, salePrice, tracksInv, active) => {
    const r = await db.execute({
      sql: `INSERT INTO products (name, category, sale_price, tracks_inventory, active, created_at, updated_at)
            VALUES (?,?,?,?,?,?,?)`,
      args: [name, category, salePrice, tracksInv ? 1 : 0, active ? 1 : 0, now, now],
    });
    return lastId(r);
  };

  const insVariant = async (productId, brand, presKg, valveType, salePrice, active, sku) => {
    await db.execute({
      sql: `INSERT INTO product_variants (product_id, brand, presentation_kg, valve_type, sale_price, active, sku, created_at, updated_at)
            VALUES (?,?,?,?,?,?,?,?,?)`,
      args: [productId, brand, presKg, valveType, salePrice, active ? 1 : 0, sku, now, now],
    });
  };

  const balloonId = await insProduct('Balón de gas',          'balón',    0,    true,  true);
                    await insProduct('Válvula Normal',         'kit',      65,   true,  true);
                    await insProduct('Válvula Premium',        'kit',      65,   true,  true);
                    await insProduct('Agua bidón 20L',         'accesorio',pWat, false, true);
                    await insProduct('Producto de limpieza',   'accesorio',pCln, false, true);

  // Balón 10 kg: cada marca × normal/premium → activo, precio = price_10kg
  // Balón 45 kg: cada marca (sin válvula) → activo, precio = price_45kg
  for (const [brand, code] of [['Flama Gas','FLA'],['Solgas','SOL'],['Otros','OTR']]) {
    await insVariant(balloonId, brand, 10, 'normal',  p10, true, `LM-${code}-10-N`);
    await insVariant(balloonId, brand, 10, 'premium', p10, true, `LM-${code}-10-P`);
    await insVariant(balloonId, brand, 45, null,      p45, true, `LM-${code}-45`);
  }
}

async function backfillClientPhones() {
  const clientRows = rows(await db.execute({
    sql: `SELECT id, phone, phone_normalized FROM clients WHERE phone IS NOT NULL AND phone != ''`,
    args: [],
  }));

  for (const client of clientRows) {
    const normalized = normalizePhone(client.phone);
    if (normalized && client.phone_normalized !== normalized) {
      await db.execute({
        sql: 'UPDATE clients SET phone_normalized = ? WHERE id = ?',
        args: [normalized, client.id],
      });
    }
  }
}

async function backfillConversationPhones() {
  const conversationRows = rows(await db.execute({
    sql: `SELECT id, phone, phone_normalized FROM wa_conversations WHERE phone IS NOT NULL AND phone != ''`,
    args: [],
  }));

  for (const conversation of conversationRows) {
    const normalized = conversation.phone_normalized || normalizePhone(conversation.phone);
    if (normalized && conversation.phone_normalized !== normalized) {
      await db.execute({
        sql: 'UPDATE wa_conversations SET phone_normalized = ? WHERE id = ?',
        args: [normalized, conversation.id],
      });
    }
  }
}

async function dedupeConversationsByPhone() {
  const duplicateGroups = rows(await db.execute({
    sql: `SELECT phone_normalized, MIN(id) as keep_id, COUNT(*) as total
          FROM wa_conversations
          WHERE phone_normalized IS NOT NULL AND phone_normalized != ''
          GROUP BY phone_normalized
          HAVING total > 1`,
    args: [],
  }));

  for (const group of duplicateGroups) {
    const duplicateRows = rows(await db.execute({
      sql: 'SELECT id FROM wa_conversations WHERE phone_normalized = ? AND id != ?',
      args: [group.phone_normalized, group.keep_id],
    }));
    const duplicateIds = duplicateRows.map(r => r.id);
    if (!duplicateIds.length) continue;

    await db.execute({
      sql: `UPDATE wa_messages
            SET conversation_id = ?
            WHERE conversation_id IN (${duplicateIds.map(() => '?').join(',')})`,
      args: [group.keep_id, ...duplicateIds],
    });
    await db.execute({
      sql: `DELETE FROM wa_conversations
            WHERE id IN (${duplicateIds.map(() => '?').join(',')})`,
      args: duplicateIds,
    });
  }
}

async function getOrCreateConversation({ phone, phoneNormalized, clientId = null, contactName = null }) {
  const normalized = phoneNormalized || normalizePhone(phone);
  if (!normalized) return null;

  const now = isoNow();
  await db.execute({
    sql: `INSERT INTO wa_conversations
            (client_id, phone, phone_normalized, contact_name, status, created_at, updated_at)
          VALUES (?, ?, ?, ?, 'open', ?, ?)
          ON CONFLICT(phone_normalized) DO UPDATE SET
            client_id = COALESCE(wa_conversations.client_id, excluded.client_id),
            phone = COALESCE(NULLIF(excluded.phone, ''), wa_conversations.phone),
            contact_name = COALESCE(NULLIF(excluded.contact_name, ''), wa_conversations.contact_name),
            updated_at = excluded.updated_at`,
    args: [clientId, phone || normalized, normalized, contactName, now, now],
  });

  return row(await db.execute({
    sql: 'SELECT * FROM wa_conversations WHERE phone_normalized = ? LIMIT 1',
    args: [normalized],
  }));
}

async function migrateLegacyWhatsappMessages() {
  const messageRows = rows(await db.execute({
    sql: `SELECT m.id, m.client_id, m.phone, m.phone_normalized, m.message, m.body,
                 m.direction, m.type, m.status, m.conversation_id, m.received_at, m.created_at,
                 c.name as client_name, c.phone as client_phone
          FROM wa_messages m
          LEFT JOIN clients c ON c.id = m.client_id
          WHERE m.conversation_id IS NULL
             OR m.body IS NULL
             OR m.direction IS NULL
             OR m.type IS NULL
             OR m.status IS NULL
             OR m.phone_normalized IS NULL
             OR m.created_at IS NULL`,
    args: [],
  }));

  for (const message of messageRows) {
    const sourcePhone = message.phone || message.client_phone;
    const normalized = message.phone_normalized || normalizePhone(sourcePhone);
    const conversation = normalized
      ? await getOrCreateConversation({
          phone: sourcePhone,
          phoneNormalized: normalized,
          clientId: message.client_id,
          contactName: message.client_name,
        })
      : null;
    const receivedAt = message.received_at || message.created_at || isoNow();

    await db.execute({
      sql: `UPDATE wa_messages
            SET body = COALESCE(body, message),
                direction = COALESCE(direction, 'inbound'),
                type = COALESCE(type, 'text'),
                status = COALESCE(status, 'received'),
                phone_normalized = COALESCE(phone_normalized, ?),
                conversation_id = COALESCE(conversation_id, ?),
                received_at = COALESCE(received_at, ?),
                created_at = COALESCE(created_at, received_at, ?)
            WHERE id = ?`,
      args: [normalized || null, conversation?.id || null, receivedAt, receivedAt, message.id],
    });
  }
}

async function rebuildConversationSummaries() {
  const conversationRows = rows(await db.execute({
    sql: 'SELECT id FROM wa_conversations',
    args: [],
  }));

  for (const conversation of conversationRows) {
    const latest = row(await db.execute({
      sql: `SELECT created_at, received_at, direction
            FROM wa_messages
            WHERE conversation_id = ?
            ORDER BY datetime(COALESCE(created_at, received_at)) DESC, id DESC
            LIMIT 1`,
      args: [conversation.id],
    }));
    const latestInbound = row(await db.execute({
      sql: `SELECT created_at, received_at
            FROM wa_messages
            WHERE conversation_id = ? AND direction = 'inbound'
            ORDER BY datetime(COALESCE(created_at, received_at)) DESC, id DESC
            LIMIT 1`,
      args: [conversation.id],
    }));
    const unread = row(await db.execute({
      sql: `SELECT COUNT(*) as total
            FROM wa_messages
            WHERE conversation_id = ? AND direction = 'inbound' AND read_at IS NULL`,
      args: [conversation.id],
    }));

    await db.execute({
      sql: `UPDATE wa_conversations
            SET last_message_at = ?,
                last_inbound_at = ?,
                unread_count = ?,
                updated_at = COALESCE(?, updated_at, CURRENT_TIMESTAMP)
            WHERE id = ?`,
      args: [
        latest ? (latest.created_at || latest.received_at) : null,
        latestInbound ? (latestInbound.created_at || latestInbound.received_at) : null,
        unread?.total || 0,
        latest ? (latest.created_at || latest.received_at) : null,
        conversation.id,
      ],
    });
  }
}

function rowsAffected(result) {
  return Number(result.rowsAffected || 0);
}

function statusRank(status) {
  if (status === 'queued') return 0;
  if (status === 'sent') return 1;
  if (status === 'delivered') return 2;
  if (status === 'read') return 3;
  if (status === 'failed') return 99;
  return -1;
}

function canAdvanceMessageStatus(currentStatus, nextStatus) {
  const currentRank = statusRank(currentStatus);
  const nextRank = statusRank(nextStatus);
  if (nextRank < 0) return false;
  if (nextStatus === 'failed') return currentStatus !== 'delivered' && currentStatus !== 'read';
  if (currentStatus === 'failed') return false;
  return nextRank >= currentRank;
}

function sendInternalError(res, context, err) {
  console.error(context, err);
  return res.status(500).json({ error: 'Error interno del servidor' });
}

function extractMessageBody(message) {
  if (message?.text?.body) return message.text.body;
  if (message?.button?.text) return message.button.text;
  if (message?.interactive?.button_reply?.title) return message.interactive.button_reply.title;
  if (message?.interactive?.list_reply?.title) return message.interactive.list_reply.title;
  if (message?.image?.caption) return message.image.caption;
  if (message?.document?.caption) return message.document.caption;
  if (message?.video?.caption) return message.video.caption;
  return '';
}

async function findOrCreateWhatsappClient({ phone, phoneNormalized, contactName, lastWhatsappAt }) {
  const normalized = phoneNormalized || normalizePhone(phone);
  if (!normalized) return null;

  const localPeruPhone = normalized.startsWith('51') && normalized.length === 11
    ? normalized.slice(2)
    : null;
  const candidates = [...new Set([normalized, phone, localPeruPhone].filter(Boolean))];

  let existing = row(await db.execute({
    sql: 'SELECT id, name, phone FROM clients WHERE phone_normalized = ? LIMIT 1',
    args: [normalized],
  }));

  if (!existing && candidates.length) {
    existing = row(await db.execute({
      sql: `SELECT id, name, phone FROM clients WHERE phone IN (${candidates.map(() => '?').join(',')}) LIMIT 1`,
      args: candidates,
    }));
  }

  if (existing) {
    await db.execute({
      sql: `UPDATE clients
            SET phone_normalized = ?,
                last_whatsapp_at = ?,
                phone = COALESCE(NULLIF(phone, ''), ?)
            WHERE id = ?`,
      args: [normalized, lastWhatsappAt, phone || normalized, existing.id],
    });
    return { ...existing, phone_normalized: normalized };
  }

  const result = await db.execute({
    sql: `INSERT INTO clients (name, phone, phone_normalized, notes, last_whatsapp_at)
          VALUES (?, ?, ?, ?, ?)`,
    args: [contactName || phone || normalized, phone || normalized, normalized, 'Contacto via WhatsApp', lastWhatsappAt],
  });

  return {
    id: lastId(result),
    name: contactName || phone || normalized,
    phone: phone || normalized,
    phone_normalized: normalized,
  };
}

async function updateConversationAfterInbound({ conversationId, clientId, phone, contactName, at }) {
  await db.execute({
    sql: `UPDATE wa_conversations
          SET client_id = COALESCE(client_id, ?),
              phone = COALESCE(NULLIF(?, ''), phone),
              contact_name = COALESCE(NULLIF(?, ''), contact_name),
              last_message_at = ?,
              last_inbound_at = ?,
              unread_count = COALESCE(unread_count, 0) + 1,
              updated_at = ?
          WHERE id = ?`,
    args: [clientId, phone, contactName, at, at, at, conversationId],
  });
}

async function processInboundWhatsappMessage(message, value, contactsByPhone) {
  const phone = message?.from;
  const phoneNormalized = normalizePhone(phone);
  if (!phoneNormalized) return;

  const contact = contactsByPhone.get(phoneNormalized);
  const contactName = contact?.profile?.name || phone;
  const receivedAt = whatsappTimestamp(message?.timestamp);
  const type = message?.type || 'text';
  const body = extractMessageBody(message);
  const waMessageId = message?.id || null;

  const client = await findOrCreateWhatsappClient({
    phone,
    phoneNormalized,
    contactName,
    lastWhatsappAt: receivedAt,
  });
  const conversation = await getOrCreateConversation({
    phone,
    phoneNormalized,
    clientId: client?.id || null,
    contactName,
  });
  if (!conversation) return;

  const insertResult = await db.execute({
    sql: `INSERT OR IGNORE INTO wa_messages
            (conversation_id, client_id, phone, phone_normalized, message, body, direction,
             type, wa_message_id, status, raw_payload, received_at, created_at)
          VALUES (?, ?, ?, ?, ?, ?, 'inbound', ?, ?, 'received', ?, ?, ?)`,
    args: [
      conversation.id,
      client?.id || null,
      phone,
      phoneNormalized,
      body,
      body,
      type,
      waMessageId,
      JSON.stringify({ message, contact, metadata: value?.metadata || null }),
      receivedAt,
      receivedAt,
    ],
  });

  if (rowsAffected(insertResult) === 0) return;

  await updateConversationAfterInbound({
    conversationId: conversation.id,
    clientId: client?.id || null,
    phone,
    contactName,
    at: receivedAt,
  });

  if (client?.id) {
    await db.execute({
      sql: 'UPDATE clients SET last_whatsapp_at = ? WHERE id = ?',
      args: [receivedAt, client.id],
    });
  }
}

async function processWhatsappStatus(statusEvent) {
  const waMessageId = statusEvent?.id;
  const nextStatus = statusEvent?.status;
  if (!waMessageId || !['sent', 'delivered', 'read', 'failed'].includes(nextStatus)) return;

  const currentMessage = row(await db.execute({
    sql: 'SELECT id, status FROM wa_messages WHERE wa_message_id = ? LIMIT 1',
    args: [waMessageId],
  }));
  if (!currentMessage || !canAdvanceMessageStatus(currentMessage.status, nextStatus)) return;

  const at = whatsappTimestamp(statusEvent?.timestamp);
  const error = Array.isArray(statusEvent?.errors) ? statusEvent.errors[0] : null;
  const errorCode = error?.code ? String(error.code) : null;
  const errorMessage = error?.message || error?.title || error?.details || null;

  await db.execute({
    sql: `UPDATE wa_messages
          SET status = ?,
              sent_at = CASE WHEN ? = 'sent' THEN COALESCE(sent_at, ?) ELSE sent_at END,
              delivered_at = CASE WHEN ? = 'delivered' THEN COALESCE(delivered_at, ?) ELSE delivered_at END,
              read_at = CASE WHEN ? = 'read' THEN COALESCE(read_at, ?) ELSE read_at END,
              error_code = CASE WHEN ? = 'failed' THEN ? ELSE error_code END,
              error_message = CASE WHEN ? = 'failed' THEN ? ELSE error_message END
          WHERE wa_message_id = ?`,
    args: [
      nextStatus,
      nextStatus, at,
      nextStatus, at,
      nextStatus, at,
      nextStatus, errorCode,
      nextStatus, errorMessage,
      waMessageId,
    ],
  });
}

async function processWhatsappWebhook(payload) {
  const entries = Array.isArray(payload?.entry) ? payload.entry : [];

  for (const entry of entries) {
    const changes = Array.isArray(entry?.changes) ? entry.changes : [];
    for (const change of changes) {
      const value = change?.value || {};
      const contactsByPhone = new Map(
        (Array.isArray(value.contacts) ? value.contacts : []).map(contact => [
          normalizePhone(contact.wa_id || contact.input),
          contact,
        ]).filter(([phone]) => phone)
      );

      const messages = Array.isArray(value.messages) ? value.messages : [];
      for (const message of messages) {
        await processInboundWhatsappMessage(message, value, contactsByPhone);
      }

      const statuses = Array.isArray(value.statuses) ? value.statuses : [];
      for (const statusEvent of statuses) {
        await processWhatsappStatus(statusEvent);
      }
    }
  }
}

function parsePositiveInteger(value) {
  if (value === undefined || value === null || value === '') return null;
  const n = Number(value);
  return Number.isInteger(n) && n > 0 ? n : null;
}

function parsePagination(query) {
  const rawLimit = query.limit === undefined ? 50 : Number(query.limit);
  const rawOffset = query.offset === undefined ? 0 : Number(query.offset);

  if (!Number.isInteger(rawLimit) || rawLimit < 1 || rawLimit > 100) {
    return { error: 'limit debe ser un entero entre 1 y 100' };
  }
  if (!Number.isInteger(rawOffset) || rawOffset < 0) {
    return { error: 'offset debe ser un entero mayor o igual a 0' };
  }
  return { limit: rawLimit, offset: rawOffset };
}

function isValidClientRequestId(value) {
  return typeof value === 'string'
    && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value.trim());
}

function isValidWhatsappPhone(value) {
  return typeof value === 'string' && /^\d{8,15}$/.test(value);
}

function isWithinWhatsappCareWindow(lastInboundAt) {
  if (!lastInboundAt) return false;
  const lastInboundMs = new Date(lastInboundAt).getTime();
  if (!Number.isFinite(lastInboundMs)) return false;
  return Date.now() - lastInboundMs <= 24 * 60 * 60 * 1000;
}

function sanitizeMetaErrorMessage(value) {
  const message = String(value || 'WhatsApp no pudo procesar el mensaje').slice(0, 500);
  return message.replace(/Bearer\s+[A-Za-z0-9._~+/=-]+/gi, 'Bearer [redacted]');
}

async function getMessageByClientRequestId(clientRequestId) {
  return row(await db.execute({
    sql: `SELECT id, conversation_id, client_id, phone, phone_normalized,
                 COALESCE(body, message, '') as body,
                 direction, type, client_request_id, wa_message_id, status,
                 error_code, error_message, sent_at, delivered_at, read_at,
                 received_at, created_at
          FROM wa_messages
          WHERE client_request_id = ?
          LIMIT 1`,
    args: [clientRequestId],
  }));
}

async function getOutboundMessage(id) {
  return row(await db.execute({
    sql: `SELECT id, conversation_id, client_id, phone, phone_normalized,
                 COALESCE(body, message, '') as body,
                 direction, type, client_request_id, wa_message_id, status,
                 error_code, error_message, sent_at, delivered_at, read_at,
                 received_at, created_at
          FROM wa_messages
          WHERE id = ?
          LIMIT 1`,
    args: [id],
  }));
}

async function markOutboundMessageFailed(messageId, code, message) {
  await db.execute({
    sql: `UPDATE wa_messages
          SET status = 'failed',
              error_code = ?,
              error_message = ?
          WHERE id = ?`,
    args: [String(code || 'WHATSAPP_SEND_FAILED'), sanitizeMetaErrorMessage(message), messageId],
  });
  return getOutboundMessage(messageId);
}

async function sendWhatsappTextMessage({ to, body }) {
  const accessToken = process.env.WHATSAPP_ACCESS_TOKEN;
  const phoneNumberId = process.env.WHATSAPP_PHONE_NUMBER_ID;
  const apiVersion = process.env.WHATSAPP_API_VERSION || DEFAULT_WHATSAPP_API_VERSION;

  if (!accessToken || !phoneNumberId) {
    return {
      ok: false,
      status: 500,
      code: 'WHATSAPP_CONFIG_MISSING',
      message: 'Configuración de WhatsApp incompleta.',
    };
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), WHATSAPP_SEND_TIMEOUT_MS);

  try {
    const response = await fetch(`https://graph.facebook.com/${apiVersion}/${phoneNumberId}/messages`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${accessToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        messaging_product: 'whatsapp',
        recipient_type: 'individual',
        to,
        type: 'text',
        text: {
          preview_url: false,
          body,
        },
      }),
      signal: controller.signal,
    });

    let payload = null;
    try {
      payload = await response.json();
    } catch (parseErr) {
      payload = null;
    }

    if (!response.ok) {
      const metaError = payload?.error || {};
      return {
        ok: false,
        status: 502,
        code: metaError.code ? String(metaError.code) : `META_HTTP_${response.status}`,
        message: sanitizeMetaErrorMessage(metaError.message || `WhatsApp respondió HTTP ${response.status}`),
      };
    }

    const waMessageId = payload?.messages?.[0]?.id;
    if (!waMessageId) {
      return {
        ok: false,
        status: 502,
        code: 'INVALID_META_RESPONSE',
        message: 'WhatsApp aceptó la solicitud, pero no devolvió un id de mensaje válido.',
      };
    }

    return { ok: true, waMessageId };
  } catch (err) {
    if (err?.name === 'AbortError') {
      return {
        ok: false,
        status: 504,
        code: 'META_TIMEOUT',
        message: 'WhatsApp no respondió dentro del tiempo esperado.',
      };
    }

    return {
      ok: false,
      status: 502,
      code: 'META_REQUEST_FAILED',
      message: 'No se pudo contactar a WhatsApp.',
    };
  } finally {
    clearTimeout(timeout);
  }
}

// ─── WHATSAPP WEBHOOK ─────────────────────────────────────────────────────────
// Verificación de Meta (GET)
app.get('/webhook/whatsapp', (req, res) => {
  const mode      = req.query['hub.mode'];
  const token     = req.query['hub.verify_token'];
  const challenge = req.query['hub.challenge'];
  if (mode === 'subscribe' && token === process.env.WHATSAPP_VERIFY_TOKEN) {
    return res.status(200).send(challenge);
  }
  res.sendStatus(403);
});

// Recepción de mensajes (POST)
app.post('/webhook/whatsapp', async (req, res) => {
  try {
    await processWhatsappWebhook(req.body);
    res.sendStatus(200);
  } catch (err) {
    console.error('Error procesando webhook WhatsApp:', err);
    res.sendStatus(500);
  }
});

// ─── AUTH ─────────────────────────────────────────────────────────────────────
app.post('/api/auth/verify', async (req, res) => {
  try {
    const { pin } = req.body;
    const cfg = await getConfig();
    res.json({ ok: pin === cfg.pin });
  } catch (err) { return sendInternalError(res, 'Error verificando PIN:', err); }
});

// ─── WHATSAPP CONVERSATIONS ──────────────────────────────────────────────────
app.get('/api/conversations', async (req, res) => {
  try {
    const pagination = parsePagination(req.query);
    if (pagination.error) return res.status(400).json({ error: pagination.error });

    const { q, status, unread } = req.query;
    if (status && !['open', 'closed', 'all'].includes(status)) {
      return res.status(400).json({ error: 'status debe ser open, closed o all' });
    }
    if (unread !== undefined && !['1', 'true', '0', 'false'].includes(String(unread))) {
      return res.status(400).json({ error: 'unread debe ser 1, 0, true o false' });
    }

    let sql = `SELECT wc.*,
                      c.name as client_name,
                      c.zone as client_zone,
                      c.type as client_type,
                      c.is_vip as client_is_vip,
                      (SELECT COALESCE(m.body, m.message, '')
                       FROM wa_messages m
                       WHERE m.conversation_id = wc.id
                       ORDER BY datetime(COALESCE(m.created_at, m.received_at)) DESC, m.id DESC
                       LIMIT 1) as last_message_body,
                      (SELECT m.direction
                       FROM wa_messages m
                       WHERE m.conversation_id = wc.id
                       ORDER BY datetime(COALESCE(m.created_at, m.received_at)) DESC, m.id DESC
                       LIMIT 1) as last_message_direction,
                      (SELECT m.status
                       FROM wa_messages m
                       WHERE m.conversation_id = wc.id
                       ORDER BY datetime(COALESCE(m.created_at, m.received_at)) DESC, m.id DESC
                       LIMIT 1) as last_message_status
               FROM wa_conversations wc
               LEFT JOIN clients c ON c.id = wc.client_id
               WHERE 1=1`;
    const args = [];

    if (status && status !== 'all') {
      sql += ' AND wc.status = ?';
      args.push(status);
    }
    if (String(unread) === '1' || String(unread) === 'true') {
      sql += ' AND COALESCE(wc.unread_count, 0) > 0';
    }
    if (q) {
      const normalizedQuery = normalizePhone(q);
      const like = `%${q}%`;
      sql += ` AND (
        wc.phone LIKE ? OR wc.contact_name LIKE ? OR c.name LIKE ? OR wc.phone_normalized LIKE ?
      )`;
      args.push(like, like, like, `%${normalizedQuery || q}%`);
    }

    sql += ` ORDER BY datetime(COALESCE(wc.last_message_at, wc.updated_at, wc.created_at)) DESC, wc.id DESC
             LIMIT ? OFFSET ?`;
    args.push(pagination.limit, pagination.offset);

    const conversationRows = rows(await db.execute({ sql, args }));
    res.json({
      conversations: conversationRows,
      pagination: {
        limit: pagination.limit,
        offset: pagination.offset,
        next_offset: conversationRows.length === pagination.limit ? pagination.offset + pagination.limit : null,
      },
    });
  } catch (err) { return sendInternalError(res, 'Error listando conversaciones:', err); }
});

app.get('/api/conversations/:id/messages', async (req, res) => {
  try {
    const conversationId = parsePositiveInteger(req.params.id);
    if (!conversationId) return res.status(400).json({ error: 'id de conversación inválido' });

    const limit = req.query.limit === undefined ? 50 : Number(req.query.limit);
    if (!Number.isInteger(limit) || limit < 1 || limit > 100) {
      return res.status(400).json({ error: 'limit debe ser un entero entre 1 y 100' });
    }
    const before = parsePositiveInteger(req.query.before);
    if (req.query.before !== undefined && !before) {
      return res.status(400).json({ error: 'before debe ser un id positivo' });
    }

    const conversation = row(await db.execute({
      sql: `SELECT wc.*, c.name as client_name, c.zone as client_zone, c.type as client_type
            FROM wa_conversations wc
            LEFT JOIN clients c ON c.id = wc.client_id
            WHERE wc.id = ?`,
      args: [conversationId],
    }));
    if (!conversation) return res.status(404).json({ error: 'Conversación no encontrada' });

    let sql = `SELECT id, conversation_id, client_id, phone, phone_normalized,
                      COALESCE(body, message, '') as body,
                      message,
                      direction, type, wa_message_id, status,
                      error_code, error_message, sent_at, delivered_at, read_at,
                      received_at, created_at
               FROM wa_messages
               WHERE conversation_id = ?`;
    const args = [conversationId];
    if (before) {
      sql += ' AND id < ?';
      args.push(before);
    }
    sql += ' ORDER BY id DESC LIMIT ?';
    args.push(limit);

    const messageRows = rows(await db.execute({ sql, args }));
    const orderedMessages = [...messageRows].reverse();
    res.json({
      conversation,
      messages: orderedMessages,
      pagination: {
        limit,
        before: before || null,
        next_before: messageRows.length === limit ? orderedMessages[0]?.id || null : null,
      },
    });
  } catch (err) { return sendInternalError(res, 'Error listando mensajes de conversación:', err); }
});

app.post('/api/conversations/:id/messages', async (req, res) => {
  try {
    const conversationId = parsePositiveInteger(req.params.id);
    if (!conversationId) return res.status(400).json({ error: 'id de conversación inválido' });

    const rawBody = req.body?.body;
    const body = typeof rawBody === 'string' ? rawBody.trim() : '';
    const clientRequestId = typeof req.body?.client_request_id === 'string'
      ? req.body.client_request_id.trim()
      : '';

    if (!body) {
      return res.status(400).json({ error: 'body debe ser un texto no vacío' });
    }
    if (body.length > MAX_WHATSAPP_TEXT_LENGTH) {
      return res.status(400).json({
        error: 'BODY_TOO_LONG',
        message: `body no debe superar ${MAX_WHATSAPP_TEXT_LENGTH} caracteres`,
      });
    }
    if (!isValidClientRequestId(clientRequestId)) {
      return res.status(400).json({ error: 'client_request_id debe ser un UUID válido' });
    }

    const existingMessage = await getMessageByClientRequestId(clientRequestId);
    if (existingMessage) {
      if (Number(existingMessage.conversation_id) !== conversationId) {
        return res.status(409).json({
          error: 'CLIENT_REQUEST_ID_CONFLICT',
          message: 'client_request_id ya fue utilizado en otra conversación.',
        });
      }
      return res.status(200).json({ message: existingMessage });
    }

    const conversation = row(await db.execute({
      sql: `SELECT wc.*, c.id as client_exists
            FROM wa_conversations wc
            LEFT JOIN clients c ON c.id = wc.client_id
            WHERE wc.id = ?`,
      args: [conversationId],
    }));
    if (!conversation) return res.status(404).json({ error: 'Conversación no encontrada' });

    const phoneNormalized = normalizePhone(conversation.phone_normalized || conversation.phone);
    if (!isValidWhatsappPhone(phoneNormalized)) {
      return res.status(422).json({
        error: 'INVALID_PHONE',
        message: 'La conversación no tiene un teléfono normalizado válido.',
      });
    }

    if (!isWithinWhatsappCareWindow(conversation.last_inbound_at)) {
      return res.status(409).json({
        error: 'TEMPLATE_REQUIRED',
        message: 'La ventana de atención de 24 horas terminó. Se requiere una plantilla aprobada.',
      });
    }

    const createdAt = isoNow();
    const insertResult = await db.execute({
      sql: `INSERT OR IGNORE INTO wa_messages
              (conversation_id, client_id, phone, phone_normalized, message, body, direction,
               type, client_request_id, status, created_at)
            VALUES (?, ?, ?, ?, ?, ?, 'outbound', 'text', ?, 'queued', ?)`,
      args: [
        conversation.id,
        conversation.client_id || null,
        conversation.phone || phoneNormalized,
        phoneNormalized,
        body,
        body,
        clientRequestId,
        createdAt,
      ],
    });

    if (rowsAffected(insertResult) === 0) {
      const duplicateMessage = await getMessageByClientRequestId(clientRequestId);
      if (duplicateMessage && Number(duplicateMessage.conversation_id) === conversationId) {
        return res.status(200).json({ message: duplicateMessage });
      }
      return res.status(409).json({
        error: 'CLIENT_REQUEST_ID_CONFLICT',
        message: 'client_request_id ya fue utilizado.',
      });
    }

    const messageId = lastId(insertResult);
    const metaResult = await sendWhatsappTextMessage({ to: phoneNormalized, body });

    if (!metaResult.ok) {
      const failedMessage = await markOutboundMessageFailed(messageId, metaResult.code, metaResult.message);
      return res.status(metaResult.status || 502).json({
        error: metaResult.code,
        message: metaResult.message,
        whatsapp_message: failedMessage,
      });
    }

    const sentAt = isoNow();
    await db.execute({
      sql: `UPDATE wa_messages
            SET status = 'sent',
                wa_message_id = ?,
                sent_at = ?
            WHERE id = ?`,
      args: [metaResult.waMessageId, sentAt, messageId],
    });
    await db.execute({
      sql: `UPDATE wa_conversations
            SET last_message_at = ?, updated_at = ?
            WHERE id = ?`,
      args: [sentAt, sentAt, conversation.id],
    });

    const sentMessage = await getOutboundMessage(messageId);
    return res.status(201).json({ message: sentMessage });
  } catch (err) { return sendInternalError(res, 'Error enviando mensaje de WhatsApp:', err); }
});

app.patch('/api/conversations/:id/read', async (req, res) => {
  try {
    const conversationId = parsePositiveInteger(req.params.id);
    if (!conversationId) return res.status(400).json({ error: 'id de conversación inválido' });

    const conversation = row(await db.execute({
      sql: 'SELECT id FROM wa_conversations WHERE id = ?',
      args: [conversationId],
    }));
    if (!conversation) return res.status(404).json({ error: 'Conversación no encontrada' });

    const readAt = isoNow();
    await db.execute({
      sql: `UPDATE wa_messages
            SET read_at = COALESCE(read_at, ?)
            WHERE conversation_id = ? AND direction = 'inbound' AND read_at IS NULL`,
      args: [readAt, conversationId],
    });
    await db.execute({
      sql: `UPDATE wa_conversations
            SET unread_count = 0, updated_at = ?
            WHERE id = ?`,
      args: [readAt, conversationId],
    });

    res.json({ ok: true });
  } catch (err) { return sendInternalError(res, 'Error marcando conversación como leída:', err); }
});

// ─── DASHBOARD ────────────────────────────────────────────────────────────────
app.get('/api/dashboard', async (req, res) => {
  try {
    const today = todayStr();
    const cfg   = await getConfig();
    const goal  = parseInt(cfg.daily_goal) || 80;

    const todayOrders = rows(await db.execute({
      sql: `SELECT o.*, c.name as client_name, c.phone as client_phone,
                   c.is_vip, r.name as rider_name
            FROM orders o
            LEFT JOIN clients c ON o.client_id = c.id
            LEFT JOIN riders r ON o.rider_id = r.id
            WHERE date(o.created_at, '-5 hours') = ?`,
      args: [today],
    }));

    const deliveredToday = todayOrders.filter(o => o.status === 'Entregado');

    const items = rows(await db.execute({
      sql: `SELECT oi.* FROM order_items oi
            JOIN orders o ON oi.order_id = o.id
            WHERE date(o.created_at, '-5 hours') = ? AND o.status = 'Entregado'`,
      args: [today],
    }));

    const balloons_10  = items.filter(i =>
      i.presentation_snapshot === '10 kg' || i.product === 'Balón 10kg'
    ).reduce((s, i) => s + i.quantity, 0);
    const balloons_40  = items.filter(i =>
      i.presentation_snapshot === '45 kg' || i.product === 'Balón 40kg'
    ).reduce((s, i) => s + i.quantity, 0);
    const balloonsToday = balloons_10 + balloons_40;
    const revenueToday  = deliveredToday.reduce((s, o) => s + (o.total || 0), 0);
    const pendingOrders = todayOrders.filter(o => o.status === 'Pendiente' || o.status === 'En camino');

    const lastWeek = new Date();
    lastWeek.setDate(lastWeek.getDate() - 7);
    const lastWeekStr = lastWeek.toISOString().slice(0, 10);

    const lastWeekItems = rows(await db.execute({
      sql: `SELECT oi.* FROM order_items oi
            JOIN orders o ON oi.order_id = o.id
            WHERE date(o.created_at, '-5 hours') = ? AND o.status = 'Entregado'
              AND (oi.product = 'Balón 10kg' OR oi.product = 'Balón 40kg')`,
      args: [lastWeekStr],
    }));
    const balloonsLastWeek = lastWeekItems.reduce((s, i) => s + i.quantity, 0);

    const revenueLastWeekRow = row(await db.execute({
      sql:  `SELECT COALESCE(SUM(total),0) as total FROM orders WHERE date(created_at, '-5 hours') = ? AND status = 'Entregado'`,
      args: [lastWeekStr],
    }));
    const revenueLastWeek = revenueLastWeekRow?.total ?? 0;

    const inactiveClients = rows(await db.execute({
      sql: `SELECT c.id, c.name, c.phone, c.zone, c.is_vip,
                   MAX(o.created_at) as last_order
            FROM clients c
            LEFT JOIN orders o ON o.client_id = c.id
            GROUP BY c.id
            HAVING last_order IS NULL OR date(last_order) <= date('now', '-7 days')
            ORDER BY c.is_vip DESC, last_order ASC
            LIMIT 20`,
      args: [],
    }));

    const highDebts = rows(await db.execute({
      sql:  `SELECT id, name, phone, debt FROM clients WHERE debt > 50 ORDER BY debt DESC LIMIT 10`,
      args: [],
    }));

    res.json({
      balloonsToday, goal, revenueToday,
      pendingOrders: pendingOrders.length,
      todayOrders:   todayOrders.length,
      inactiveClients, highDebts, balloonsLastWeek, revenueLastWeek,
      breakdown: { balloons_10, balloons_40 },
    });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ─── CLIENTS ──────────────────────────────────────────────────────────────────
app.get('/api/clients', async (req, res) => {
  try {
    const { q, zone, type, sort } = req.query;
    let sql = `SELECT c.*,
        (SELECT MAX(created_at) FROM orders WHERE client_id = c.id) as last_order,
        (SELECT COUNT(*) FROM orders WHERE client_id = c.id) as order_count
      FROM clients c WHERE 1=1`;
    const args = [];
    if (q)    { sql += ` AND (c.name LIKE ? OR c.address LIKE ? OR c.phone LIKE ?)`; const p = `%${q}%`; args.push(p, p, p); }
    if (zone) { sql += ` AND c.zone = ?`;  args.push(zone); }
    if (type) { sql += ` AND c.type = ?`;  args.push(type); }
    sql += sort === 'name' ? ` ORDER BY c.name ASC` : ` ORDER BY last_order ASC NULLS FIRST`;
    res.json(rows(await db.execute({ sql, args })));
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/api/clients/:id', async (req, res) => {
  try {
    const client = row(await db.execute({ sql: 'SELECT * FROM clients WHERE id = ?', args: [req.params.id] }));
    if (!client) return res.status(404).json({ error: 'No encontrado' });

    const orderList = rows(await db.execute({
      sql: `SELECT o.*, r.name as rider_name FROM orders o
            LEFT JOIN riders r ON o.rider_id = r.id
            WHERE o.client_id = ? ORDER BY o.created_at DESC LIMIT 50`,
      args: [req.params.id],
    }));

    let itemList = [];
    if (orderList.length) {
      const ids = orderList.map(o => o.id);
      itemList = rows(await db.execute({
        sql:  `SELECT * FROM order_items WHERE order_id IN (${ids.map(() => '?').join(',')})`,
        args: ids,
      }));
    }

    const ordersWithItems = orderList.map(o => ({
      ...o,
      items: itemList.filter(i => i.order_id === o.id),
    }));
    res.json({ ...client, orders: ordersWithItems });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/clients', async (req, res) => {
  try {
    const { name, address, reference, zone, phone, type, business_type, preferred_balloon, purchase_frequency, notes, is_vip } = req.body;
    const phoneNormalized = normalizePhone(phone) || null;
    const r = await db.execute({
      sql:  `INSERT INTO clients (name, address, reference, zone, phone, phone_normalized, type, business_type, preferred_balloon, purchase_frequency, notes, is_vip)
             VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
      args: [name, address, reference, zone || 'Otra', phone, phoneNormalized, type || 'Residencial', business_type, preferred_balloon || '10kg', purchase_frequency || 'irregular', notes, is_vip ? 1 : 0],
    });
    res.json({ id: lastId(r) });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.put('/api/clients/:id', async (req, res) => {
  try {
    const { name, address, reference, zone, phone, type, business_type, preferred_balloon, purchase_frequency, notes, is_vip, debt } = req.body;
    const phoneNormalized = normalizePhone(phone) || null;
    await db.execute({
      sql:  `UPDATE clients SET name=?, address=?, reference=?, zone=?, phone=?, phone_normalized=?, type=?, business_type=?,
             preferred_balloon=?, purchase_frequency=?, notes=?, is_vip=?, debt=? WHERE id=?`,
      args: [name, address, reference, zone, phone, phoneNormalized, type, business_type, preferred_balloon, purchase_frequency, notes, is_vip ? 1 : 0, debt || 0, req.params.id],
    });
    res.json({ ok: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.delete('/api/clients/:id', async (req, res) => {
  const cid = req.params.id;
  const tx = await db.transaction('write');
  try {
    // Borrado en cascada: pedidos del cliente y todo lo que cuelga de ellos
    const orderIds = rows(await tx.execute({
      sql: 'SELECT id FROM orders WHERE client_id = ?', args: [cid],
    })).map(o => o.id);

    if (orderIds.length) {
      const ph = orderIds.map(() => '?').join(',');
      await tx.execute({ sql: `DELETE FROM cash_handovers WHERE payment_id IN (SELECT id FROM payments WHERE order_id IN (${ph}))`, args: orderIds });
      await tx.execute({ sql: `DELETE FROM payment_events  WHERE payment_id IN (SELECT id FROM payments WHERE order_id IN (${ph}))`, args: orderIds });
      await tx.execute({ sql: `DELETE FROM payments    WHERE order_id IN (${ph})`, args: orderIds });
      await tx.execute({ sql: `DELETE FROM order_items WHERE order_id IN (${ph})`, args: orderIds });
      await tx.execute({ sql: `DELETE FROM orders      WHERE id       IN (${ph})`, args: orderIds });
    }

    // Conversaciones y mensajes de WhatsApp del cliente
    await tx.execute({
      sql: `DELETE FROM wa_messages WHERE client_id = ?
              OR conversation_id IN (SELECT id FROM wa_conversations WHERE client_id = ?)`,
      args: [cid, cid],
    });
    await tx.execute({ sql: 'DELETE FROM wa_conversations WHERE client_id = ?', args: [cid] });

    await tx.execute({ sql: 'DELETE FROM clients WHERE id = ?', args: [cid] });
    await tx.commit();
    res.json({ ok: true });
  } catch (err) {
    await tx.rollback();
    res.status(500).json({ error: err.message });
  }
});

// ─── ORDERS ───────────────────────────────────────────────────────────────────
app.get('/api/orders', async (req, res) => {
  try {
    const { date, rider_id, status } = req.query;
    const d = date || todayStr();
    let sql = `SELECT o.*, c.name as client_name, c.phone as client_phone, c.address as client_address,
                      c.debt as client_debt, r.name as rider_name
               FROM orders o
               LEFT JOIN clients c ON o.client_id = c.id
               LEFT JOIN riders r ON o.rider_id = r.id
               WHERE date(o.created_at, '-5 hours') = ?`;
    const args = [d];
    if (rider_id) { sql += ` AND o.rider_id = ?`; args.push(rider_id); }
    if (status)   { sql += ` AND o.status = ?`;   args.push(status); }
    sql += ` ORDER BY o.created_at DESC`;

    const orderList = rows(await db.execute({ sql, args }));
    const ids = orderList.map(o => o.id);
    let itemList = [];
    if (ids.length) {
      itemList = rows(await db.execute({
        sql:  `SELECT * FROM order_items WHERE order_id IN (${ids.map(() => '?').join(',')})`,
        args: ids,
      }));
    }
    res.json(orderList.map(o => ({ ...o, items: itemList.filter(i => i.order_id === o.id) })));
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/api/orders/:id', async (req, res) => {
  try {
    const order = row(await db.execute({
      sql: `SELECT o.*, c.name as client_name, c.phone as client_phone, c.address as client_address,
                   c.debt as client_debt, r.name as rider_name
            FROM orders o
            LEFT JOIN clients c ON o.client_id = c.id
            LEFT JOIN riders r ON o.rider_id = r.id
            WHERE o.id = ?`,
      args: [req.params.id],
    }));
    if (!order) return res.status(404).json({ error: 'No encontrado' });
    const itemList = rows(await db.execute({ sql: 'SELECT * FROM order_items WHERE order_id = ?', args: [req.params.id] }));
    res.json({ ...order, items: itemList });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// Returns a {sql, args} statement — compatible with db.execute() and tx.execute()
function buildItemStmt(orderId, item) {
  const productText = item.product_name_snapshot || item.product || '';
  const subtotal    = item.quantity * item.unit_price;
  return {
    sql: `INSERT INTO order_items
            (order_id, product, description, quantity, unit_price, subtotal,
             product_id, variant_id, product_name_snapshot, category_snapshot,
             brand_snapshot, presentation_snapshot, valve_type_snapshot, catalog_unit_price)
          VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    args: [
      orderId, productText, item.description || '',
      item.quantity, item.unit_price, subtotal,
      item.product_id             ?? null, item.variant_id             ?? null,
      item.product_name_snapshot  ?? null, item.category_snapshot      ?? null,
      item.brand_snapshot         ?? null, item.presentation_snapshot  ?? null,
      item.valve_type_snapshot    ?? null, item.catalog_unit_price     ?? null,
    ],
  };
}

// ─── ORDER / STATUS ENUMS ──────────────────────────────────────────────────────
const ALLOWED_ORDER_STATUSES  = ['Pendiente', 'En camino', 'Entregado', 'Cancelado'];
const ORDER_PAYMENT_METHODS   = ['Efectivo', 'Yape', 'Plin', 'Transferencias', 'T/C', 'Crédito'];

// "Crédito" (antes "Fiado") es el método que suma a la deuda del cliente.
// Se aceptan ambos para mantener compatibilidad con pedidos antiguos.
function isCreditMethod(pm) { return pm === 'Crédito' || pm === 'Fiado'; }

// ─── CATALOG VARIANT RULES ─────────────────────────────────────────────────────
const ALLOWED_VALVE_TYPES = ['normal', 'premium'];

// Returns an error string on violation, null on valid.
// product: row from products table (must have .category)
// variantData: merged object with at least { presentation_kg, valve_type }
function validateVariantRules(product, variantData) {
  const presKg = variantData.presentation_kg != null ? Number(variantData.presentation_kg) : null;
  const valve  = variantData.valve_type;             // null, undefined, '' or 'normal'/'premium'
  const valvePresent = valve !== null && valve !== undefined && valve !== '';

  if (product.category === 'balón') {
    if (presKg === 10) {
      if (!ALLOWED_VALVE_TYPES.includes(valve)) {
        return 'Balón de 10 kg requiere valve_type "normal" o "premium"';
      }
    } else if (presKg === 45) {
      if (valvePresent) {
        return 'Balón de 45 kg no puede tener valve_type (debe ser null)';
      }
    } else {
      return `presentation_kg debe ser 10 o 45 para balones (recibido: ${presKg})`;
    }
  } else {
    if (valvePresent) {
      return `Productos de categoría "${product.category}" no pueden tener valve_type`;
    }
  }
  return null;
}

// ─── ORDER ITEM VALIDATION & SNAPSHOT ENRICHMENT ──────────────────────────────
// Validates items and (for catalog_version=1) enriches with server-side snapshots.
// Throws { status, message } on validation failure.
// executor: db or an open transaction — reads happen through the same connection.
async function validateAndEnrichItems(items, catalogVersion, executor = db) {
  const enriched = [];
  for (let idx = 0; idx < (items || []).length; idx++) {
    const item = items[idx];
    const pos  = `Ítem ${idx + 1}`;
    const qty  = parseInt(item.quantity, 10);
    const price = parseFloat(item.unit_price);

    if (!Number.isFinite(qty) || qty <= 0) {
      throw { status: 400, message: `${pos}: quantity debe ser un entero mayor que cero (recibido: ${item.quantity})` };
    }
    if (!Number.isFinite(price) || price <= 0) {
      throw { status: 400, message: `${pos}: unit_price debe ser mayor que cero (recibido: ${item.unit_price})` };
    }

    if (catalogVersion !== 1) {
      // Legacy: keep product text as-is, no catalog validation, no snapshots
      enriched.push({
        product:               item.product || '',
        description:           item.description || '',
        quantity:              qty,
        unit_price:            price,
        product_id:            null,
        variant_id:            null,
        product_name_snapshot: null,
        category_snapshot:     null,
        brand_snapshot:        null,
        presentation_snapshot: null,
        valve_type_snapshot:   null,
        catalog_unit_price:    null,
      });
      continue;
    }

    // catalog_version=1: require product_id, validate catalog state, generate snapshots
    if (!item.product_id) {
      throw { status: 400, message: `${pos}: product_id requerido para pedidos con catalog_version=1` };
    }
    const product = row(await executor.execute({
      sql: 'SELECT * FROM products WHERE id = ?',
      args: [item.product_id],
    }));
    if (!product) {
      throw { status: 400, message: `${pos}: producto id=${item.product_id} no existe` };
    }
    if (!product.active) {
      throw { status: 400, message: `${pos}: producto "${product.name}" está inactivo — no se puede pedir` };
    }

    let variant = null;
    let catalogPrice = product.sale_price || 0;

    if (item.variant_id) {
      variant = row(await executor.execute({
        sql: 'SELECT * FROM product_variants WHERE id = ? AND product_id = ?',
        args: [item.variant_id, item.product_id],
      }));
      if (!variant) {
        throw { status: 400, message: `${pos}: variante id=${item.variant_id} no existe o no pertenece al producto ${item.product_id}` };
      }
      if (!variant.active) {
        throw { status: 400, message: `${pos}: variante "${variant.brand} ${variant.presentation_kg}kg" está inactiva` };
      }
      if (!variant.sale_price || variant.sale_price <= 0) {
        throw { status: 400, message: `${pos}: variante sin precio configurado (pendiente de activar)` };
      }
      catalogPrice = variant.sale_price;
    } else if (product.category === 'balón') {
      throw { status: 400, message: `${pos}: los balones de gas requieren variant_id` };
    } else if (!product.sale_price || product.sale_price <= 0) {
      throw { status: 400, message: `${pos}: producto "${product.name}" sin precio — pendiente de configurar` };
    }

    const presSnap = variant?.presentation_kg != null ? `${variant.presentation_kg} kg` : null;
    const nameSnap = variant
      ? [variant.brand, presSnap, variant.valve_type ? `válvula ${variant.valve_type}` : null].filter(Boolean).join(' ')
      : product.name;

    enriched.push({
      product:               nameSnap,
      description:           item.description || '',
      quantity:              qty,
      unit_price:            price,
      product_id:            product.id,
      variant_id:            variant?.id ?? null,
      product_name_snapshot: nameSnap,
      category_snapshot:     product.category,
      brand_snapshot:        variant?.brand ?? null,
      presentation_snapshot: presSnap,
      valve_type_snapshot:   variant?.valve_type ?? null,
      catalog_unit_price:    catalogPrice,
    });
  }
  return enriched;
}

app.post('/api/orders', async (req, res) => {
  try {
    const { client_id, rider_id, payment_method, notes, items, catalog_version } = req.body;
    const cv = catalog_version === 1 ? 1 : 0;

    if (!items || !items.length) return res.status(400).json({ error: 'El pedido debe tener al menos un ítem' });

    // Open transaction first so catalog reads and writes share the same snapshot (M1: TOCTOU fix)
    const tx = await db.transaction('write');
    try {
      const enriched = await validateAndEnrichItems(items, cv, tx);
      const total = enriched.reduce((s, i) => s + i.quantity * i.unit_price, 0);

      const r = await tx.execute({
        sql:  'INSERT INTO orders (client_id, rider_id, payment_method, notes, total, catalog_version) VALUES (?,?,?,?,?,?)',
        args: [client_id ?? null, rider_id ?? null, payment_method || 'Efectivo', notes ?? null, total, cv],
      });
      const orderId = lastId(r);
      for (const item of enriched) {
        await tx.execute(buildItemStmt(orderId, item));
      }
      if (isCreditMethod(payment_method) && client_id) {
        await tx.execute({ sql: 'UPDATE clients SET debt = debt + ? WHERE id = ?', args: [total, client_id] });
      }
      await tx.commit();
      res.json({ id: orderId });
    } catch (txErr) {
      await tx.rollback();
      throw txErr;
    }
  } catch (err) {
    if (err.status) return res.status(err.status).json({ error: err.message });
    res.status(500).json({ error: err.message });
  }
});

app.put('/api/orders/:id', async (req, res) => {
  try {
    const { status, rider_id, payment_method, notes, items } = req.body;
    const oid      = req.params.id;
    const existing = row(await db.execute({ sql: 'SELECT * FROM orders WHERE id = ?', args: [oid] }));
    if (!existing) return res.status(404).json({ error: 'No encontrado' });

    // H4: validate status enum
    if (status !== undefined && !ALLOWED_ORDER_STATUSES.includes(status)) {
      return res.status(400).json({ error: `Estado inválido. Permitidos: ${ALLOWED_ORDER_STATUSES.join(', ')}` });
    }

    if (items !== undefined && items !== null && !items.length) {
      return res.status(400).json({ error: 'El pedido debe tener al menos un ítem' });
    }

    const newCv             = req.body.catalog_version ?? existing.catalog_version ?? 0;
    const newPaymentMethod  = payment_method ?? existing.payment_method;
    const newStatus         = status         ?? existing.status;

    // Atomic: catalog reads + all writes share the same transaction (M1: TOCTOU fix)
    const tx = await db.transaction('write');
    try {
      let enriched = null;
      let newTotal  = existing.total;
      if (items) {
        enriched = await validateAndEnrichItems(items, newCv, tx);
        newTotal = enriched.reduce((s, i) => s + i.quantity * i.unit_price, 0);
      }

      const deliveredAt = newStatus === 'Entregado' && existing.status !== 'Entregado'
        ? new Date().toISOString()
        : existing.delivered_at;

      // H2: compute debt delta from old vs new (Crédito total contribution)
      const oldDebtContrib = isCreditMethod(existing.payment_method) ? (existing.total || 0) : 0;
      const newDebtContrib = isCreditMethod(newPaymentMethod)        ? newTotal               : 0;
      const debtDelta      = newDebtContrib - oldDebtContrib;

      await tx.execute({
        sql:  'UPDATE orders SET status=?, rider_id=?, payment_method=?, notes=?, total=?, delivered_at=?, catalog_version=? WHERE id=?',
        args: [newStatus, rider_id ?? existing.rider_id, newPaymentMethod, notes ?? existing.notes, newTotal, deliveredAt, newCv, oid],
      });
      if (enriched) {
        await tx.execute({ sql: 'DELETE FROM order_items WHERE order_id = ?', args: [oid] });
        for (const item of enriched) {
          await tx.execute(buildItemStmt(oid, item));
        }
      }
      if (debtDelta !== 0 && existing.client_id) {
        await tx.execute({ sql: 'UPDATE clients SET debt = debt + ? WHERE id = ?', args: [debtDelta, existing.client_id] });
      }
      await tx.commit();
      res.json({ ok: true });
    } catch (txErr) {
      await tx.rollback();
      throw txErr;
    }
  } catch (err) {
    if (err.status) return res.status(err.status).json({ error: err.message });
    res.status(500).json({ error: err.message });
  }
});

app.patch('/api/orders/:id/status', async (req, res) => {
  try {
    const { status } = req.body;

    // H4: validate status enum
    if (!ALLOWED_ORDER_STATUSES.includes(status)) {
      return res.status(400).json({ error: `Estado inválido. Permitidos: ${ALLOWED_ORDER_STATUSES.join(', ')}` });
    }

    const existing = row(await db.execute({ sql: 'SELECT * FROM orders WHERE id = ?', args: [req.params.id] }));
    if (!existing) return res.status(404).json({ error: 'No encontrado' });

    const deliveredAt = status === 'Entregado' ? new Date().toISOString() : existing.delivered_at;

    // H2: reconcile Crédito debt on cancel / un-cancel
    let debtDelta = 0;
    if (existing.client_id && isCreditMethod(existing.payment_method)) {
      if (status === 'Cancelado' && existing.status !== 'Cancelado') {
        debtDelta = -(existing.total || 0);
      } else if (existing.status === 'Cancelado' && status !== 'Cancelado') {
        debtDelta = existing.total || 0;
      }
    }

    if (debtDelta !== 0) {
      const tx = await db.transaction('write');
      try {
        await tx.execute({ sql: 'UPDATE orders SET status=?, delivered_at=? WHERE id=?', args: [status, deliveredAt, req.params.id] });
        await tx.execute({ sql: 'UPDATE clients SET debt = debt + ? WHERE id = ?', args: [debtDelta, existing.client_id] });
        await tx.commit();
      } catch (txErr) { await tx.rollback(); throw txErr; }
    } else {
      await db.execute({ sql: 'UPDATE orders SET status=?, delivered_at=? WHERE id=?', args: [status, deliveredAt, req.params.id] });
    }

    res.json({ ok: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.delete('/api/orders/:id', async (req, res) => {
  try {
    const oid = req.params.id;
    const existing = row(await db.execute({ sql: 'SELECT * FROM orders WHERE id = ?', args: [oid] }));
    if (!existing) return res.status(404).json({ error: 'No encontrado' });

    const tx = await db.transaction('write');
    try {
      // M5: remove payment audit trail before removing the order
      await tx.execute({
        sql: `DELETE FROM cash_handovers WHERE payment_id IN (SELECT id FROM payments WHERE order_id = ?)`,
        args: [oid],
      });
      await tx.execute({
        sql: `DELETE FROM payment_events WHERE payment_id IN (SELECT id FROM payments WHERE order_id = ?)`,
        args: [oid],
      });
      await tx.execute({ sql: 'DELETE FROM payments WHERE order_id = ?', args: [oid] });
      await tx.execute({ sql: 'DELETE FROM order_items WHERE order_id = ?', args: [oid] });
      await tx.execute({ sql: 'DELETE FROM orders WHERE id = ?', args: [oid] });
      // H2: remove Crédito debt only if order was not already cancelled (cancelled orders already had debt removed)
      if (isCreditMethod(existing.payment_method) && existing.client_id && existing.status !== 'Cancelado') {
        await tx.execute({ sql: 'UPDATE clients SET debt = debt + ? WHERE id = ?', args: [-(existing.total || 0), existing.client_id] });
      }
      await tx.commit();
    } catch (txErr) { await tx.rollback(); throw txErr; }

    res.json({ ok: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ─── RIDERS ───────────────────────────────────────────────────────────────────
app.get('/api/riders', async (req, res) => {
  try {
    const today   = todayStr();
    const weekStart = new Date(); weekStart.setDate(weekStart.getDate() - 6);
    const weekStr   = weekStart.toISOString().slice(0, 10);

    const riderList = rows(await db.execute({ sql: 'SELECT * FROM riders WHERE active = 1 ORDER BY name', args: [] }));

    // Run per-rider queries in parallel
    const result = await Promise.all(riderList.map(async rider => {
      const [todayOrdersRow, deliveredRow, weekItemsResult] = await Promise.all([
        db.execute({ sql: `SELECT COUNT(*) as cnt FROM orders WHERE rider_id=? AND date(created_at, '-5 hours')=?`,           args: [rider.id, today] }),
        db.execute({ sql: `SELECT COUNT(*) as cnt FROM orders WHERE rider_id=? AND date(created_at, '-5 hours')=? AND status='Entregado'`, args: [rider.id, today] }),
        db.execute({ sql: `SELECT oi.quantity FROM order_items oi JOIN orders o ON oi.order_id=o.id
                           WHERE o.rider_id=? AND o.status='Entregado' AND date(o.created_at, '-5 hours')>=?
                             AND (oi.product='Balón 10kg' OR oi.product='Balón 40kg')`,
                    args: [rider.id, weekStr] }),
      ]);
      const weekBalloons = rows(weekItemsResult).reduce((s, i) => s + i.quantity, 0);
      return {
        ...rider,
        todayOrders:  row(todayOrdersRow)?.cnt  ?? 0,
        delivered:    row(deliveredRow)?.cnt     ?? 0,
        weekBalloons,
      };
    }));
    res.json(result);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/api/riders/:id', async (req, res) => {
  try {
    const rider = row(await db.execute({ sql: 'SELECT * FROM riders WHERE id=?', args: [req.params.id] }));
    if (!rider) return res.status(404).json({ error: 'No encontrado' });
    const today = todayStr();
    const todayOrders = rows(await db.execute({
      sql: `SELECT o.*, c.name as client_name, c.address as client_address FROM orders o
            LEFT JOIN clients c ON o.client_id=c.id
            WHERE o.rider_id=? AND date(o.created_at, '-5 hours')=? ORDER BY o.created_at DESC`,
      args: [rider.id, today],
    }));
    res.json({ ...rider, todayOrders });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/riders', async (req, res) => {
  try {
    const { name, phone, zone } = req.body;
    const r = await db.execute({ sql: 'INSERT INTO riders (name, phone, zone) VALUES (?,?,?)', args: [name, phone, zone] });
    res.json({ id: lastId(r) });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.put('/api/riders/:id', async (req, res) => {
  try {
    const { name, phone, zone, active } = req.body;
    await db.execute({ sql: 'UPDATE riders SET name=?, phone=?, zone=?, active=? WHERE id=?', args: [name, phone, zone, active ?? 1, req.params.id] });
    res.json({ ok: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ─── REPORTS ──────────────────────────────────────────────────────────────────
app.get('/api/reports/sales', async (req, res) => {
  try {
    const { from, to, group_by } = req.query;
    const fromDate = from || new Date(new Date().getFullYear(), new Date().getMonth(), 1).toISOString().slice(0,10);
    const toDate   = to || todayStr();
    // Build date grouping expression for the CTE
    let periodExpr;
    if (group_by === 'week')       periodExpr = `strftime('%Y-W%W', created_at, '-5 hours')`;
    else if (group_by === 'month') periodExpr = `strftime('%Y-%m', created_at, '-5 hours')`;
    else                           periodExpr = `date(created_at, '-5 hours')`;

    // CTE ensures each order's total is counted exactly once (no LEFT JOIN multiplication)
    const sales = rows(await db.execute({
      sql: `WITH o_totals AS (
              SELECT id, total, ${periodExpr} AS period
              FROM orders
              WHERE date(created_at, '-5 hours') BETWEEN ? AND ? AND status = 'Entregado'
            ),
            i_agg AS (
              SELECT order_id,
                COALESCE(SUM(CASE WHEN presentation_snapshot='10 kg' OR product='Balón 10kg' THEN quantity ELSE 0 END),0) AS balloons_10,
                COALESCE(SUM(CASE WHEN presentation_snapshot='45 kg' OR product='Balón 40kg' THEN quantity ELSE 0 END),0) AS balloons_40,
                COALESCE(SUM(CASE WHEN (category_snapshot='accesorio' AND product_name_snapshot LIKE '%bidón%') OR product='Agua bidón 20L' THEN quantity ELSE 0 END),0) AS water
              FROM order_items GROUP BY order_id
            )
            SELECT ot.period,
              COUNT(ot.id)                        AS orders,
              COALESCE(SUM(ot.total), 0)           AS revenue,
              COALESCE(SUM(ia.balloons_10), 0)     AS balloons_10,
              COALESCE(SUM(ia.balloons_40), 0)     AS balloons_40,
              COALESCE(SUM(ia.water), 0)           AS water
            FROM o_totals ot
            LEFT JOIN i_agg ia ON ia.order_id = ot.id
            GROUP BY ot.period ORDER BY ot.period`,
      args: [fromDate, toDate],
    }));
    res.json(sales);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/api/reports/by-zone', async (req, res) => {
  try {
    const { from, to } = req.query;
    const fromDate = from || new Date(new Date().getFullYear(), new Date().getMonth(), 1).toISOString().slice(0,10);
    const toDate   = to || todayStr();
    res.json(rows(await db.execute({
      sql: `WITH o_totals AS (
              SELECT o.id, o.total, o.client_id
              FROM orders o
              WHERE date(o.created_at, '-5 hours') BETWEEN ? AND ? AND o.status = 'Entregado'
            ),
            i_agg AS (
              SELECT order_id,
                COALESCE(SUM(CASE WHEN category_snapshot='balón' OR product LIKE 'Balón%' THEN quantity ELSE 0 END),0) AS balloons
              FROM order_items GROUP BY order_id
            )
            SELECT c.zone,
              COUNT(DISTINCT ot.id)           AS orders,
              COALESCE(SUM(ot.total), 0)       AS revenue,
              COALESCE(SUM(ia.balloons), 0)    AS balloons
            FROM o_totals ot
            JOIN clients c ON c.id = ot.client_id
            LEFT JOIN i_agg ia ON ia.order_id = ot.id
            GROUP BY c.zone ORDER BY revenue DESC`,
      args: [fromDate, toDate],
    })));
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/api/reports/by-product', async (req, res) => {
  try {
    const { from, to } = req.query;
    const fromDate = from || new Date(new Date().getFullYear(), new Date().getMonth(), 1).toISOString().slice(0,10);
    const toDate   = to || todayStr();
    res.json(rows(await db.execute({
      sql: `SELECT oi.product, SUM(oi.quantity) as quantity, SUM(oi.subtotal) as revenue, AVG(oi.unit_price) as avg_price
            FROM order_items oi JOIN orders o ON oi.order_id=o.id
            WHERE date(o.created_at, '-5 hours') BETWEEN ? AND ? AND o.status='Entregado'
            GROUP BY oi.product ORDER BY revenue DESC`,
      args: [fromDate, toDate],
    })));
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/api/reports/by-rider', async (req, res) => {
  try {
    const { from, to } = req.query;
    const fromDate = from || new Date(new Date().getFullYear(), new Date().getMonth(), 1).toISOString().slice(0,10);
    const toDate   = to || todayStr();
    res.json(rows(await db.execute({
      sql: `WITH o_totals AS (
              SELECT o.id, o.total, o.rider_id
              FROM orders o
              WHERE date(o.created_at, '-5 hours') BETWEEN ? AND ? AND o.status = 'Entregado'
            ),
            i_agg AS (
              SELECT order_id,
                COALESCE(SUM(CASE WHEN category_snapshot='balón' OR product LIKE 'Balón%' THEN quantity ELSE 0 END),0) AS balloons
              FROM order_items GROUP BY order_id
            )
            SELECT r.name, r.id AS rider_id,
              COUNT(DISTINCT ot.id)         AS orders,
              COALESCE(SUM(ot.total), 0)     AS revenue,
              COALESCE(SUM(ia.balloons), 0)  AS balloons
            FROM o_totals ot
            JOIN riders r ON r.id = ot.rider_id
            LEFT JOIN i_agg ia ON ia.order_id = ot.id
            GROUP BY r.id ORDER BY revenue DESC`,
      args: [fromDate, toDate],
    })));
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/api/reports/top-clients', async (req, res) => {
  try {
    const { from, to } = req.query;
    const fromDate = from || new Date(new Date().getFullYear(), new Date().getMonth(), 1).toISOString().slice(0,10);
    const toDate   = to || todayStr();
    res.json(rows(await db.execute({
      sql: `WITH o_totals AS (
              SELECT o.id, o.total, o.client_id
              FROM orders o
              WHERE date(o.created_at, '-5 hours') BETWEEN ? AND ? AND o.status = 'Entregado'
            ),
            i_agg AS (
              SELECT order_id,
                COALESCE(SUM(CASE WHEN category_snapshot='balón' OR product LIKE 'Balón%' THEN quantity ELSE 0 END),0) AS balloons
              FROM order_items GROUP BY order_id
            )
            SELECT c.id, c.name, c.phone, c.zone, c.is_vip,
              COUNT(DISTINCT ot.id)         AS orders,
              COALESCE(SUM(ot.total), 0)     AS revenue,
              COALESCE(SUM(ia.balloons), 0)  AS balloons
            FROM clients c
            JOIN o_totals ot ON ot.client_id = c.id
            LEFT JOIN i_agg ia ON ia.order_id = ot.id
            GROUP BY c.id ORDER BY revenue DESC LIMIT 10`,
      args: [fromDate, toDate],
    })));
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/api/reports/inactive', async (req, res) => {
  try {
    const d = parseInt(req.query.days) || 7;
    // Calculate cutoff date in JS to avoid SQL string concatenation with args
    const cutoff = new Date();
    cutoff.setDate(cutoff.getDate() - d);
    const cutoffStr = cutoff.toISOString().slice(0, 10);
    res.json(rows(await db.execute({
      sql: `SELECT c.id, c.name, c.phone, c.zone, c.type, c.is_vip,
              MAX(o.created_at) as last_order, COUNT(o.id) as total_orders
            FROM clients c LEFT JOIN orders o ON o.client_id=c.id
            GROUP BY c.id
            HAVING last_order IS NULL OR date(last_order) <= ?
            ORDER BY c.is_vip DESC, last_order ASC`,
      args: [cutoffStr],
    })));
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/api/reports/debts', async (req, res) => {
  try {
    res.json(rows(await db.execute({ sql: `SELECT id, name, phone, zone, debt FROM clients WHERE debt > 0 ORDER BY debt DESC`, args: [] })));
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/api/reports/avg-ticket', async (req, res) => {
  try {
    const { from, to } = req.query;
    const fromDate = from || new Date(new Date().getFullYear(), new Date().getMonth(), 1).toISOString().slice(0,10);
    const toDate   = to || todayStr();
    res.json(row(await db.execute({
      sql:  `SELECT COALESCE(AVG(total),0) as avg_ticket, COUNT(*) as orders, COALESCE(SUM(total),0) as total FROM orders WHERE date(created_at, '-5 hours') BETWEEN ? AND ? AND status='Entregado'`,
      args: [fromDate, toDate],
    })));
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// Export Excel — inactive clients
app.get('/api/reports/export/inactive', async (req, res) => {
  try {
    const d = parseInt(req.query.days) || 7;
    const cutoff = new Date(); cutoff.setDate(cutoff.getDate() - d);
    const cutoffStr = cutoff.toISOString().slice(0, 10);
    const data = rows(await db.execute({
      sql: `SELECT c.name as Nombre, c.phone as WhatsApp, c.zone as Zona, c.type as Tipo,
              MAX(o.created_at) as 'Último Pedido', COUNT(o.id) as 'Total Pedidos'
            FROM clients c LEFT JOIN orders o ON o.client_id=c.id
            GROUP BY c.id
            HAVING 'Último Pedido' IS NULL OR date('Último Pedido') <= ?
            ORDER BY 'Último Pedido' ASC`,
      args: [cutoffStr],
    }));
    const wb = new ExcelJS.Workbook();
    const ws = wb.addWorksheet('Clientes Inactivos');
    if (data.length > 0) {
      ws.columns = Object.keys(data[0]).map(k => ({ header: k, key: k, width: 20 }));
      data.forEach(r => ws.addRow(Object.fromEntries(Object.entries(r))));
    }
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', `attachment; filename="clientes_inactivos.xlsx"`);
    await wb.xlsx.write(res);
    res.end();
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ─── CATALOG ──────────────────────────────────────────────────────────────────
app.get('/api/catalog', async (req, res) => {
  try {
    const products  = rows(await db.execute({ sql: 'SELECT * FROM products ORDER BY category, name', args: [] }));
    const variants  = rows(await db.execute({ sql: 'SELECT * FROM product_variants ORDER BY product_id, presentation_kg, brand', args: [] }));
    res.json(products.map(p => ({ ...p, variants: variants.filter(v => v.product_id === p.id) })));
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/api/catalog/available', async (req, res) => {
  try {
    const products = rows(await db.execute({ sql: 'SELECT * FROM products WHERE active=1 ORDER BY category, name', args: [] }));
    const variants = rows(await db.execute({
      sql: `SELECT * FROM product_variants WHERE active=1 AND sale_price IS NOT NULL AND sale_price > 0
            ORDER BY product_id, presentation_kg, brand`,
      args: [],
    }));
    const result = products.map(p => {
      const pvs = variants.filter(v => v.product_id === p.id);
      if (pvs.length > 0) return { ...p, variants: pvs };
      if (p.sale_price > 0) return { ...p, variants: [] };
      return null;
    }).filter(Boolean);
    res.json(result);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/catalog/products', async (req, res) => {
  try {
    const { name, category, description, sku, sale_price, unit, tracks_inventory, active } = req.body;
    if (!name || !category) return res.status(400).json({ error: 'name y category requeridos' });
    const now = isoNow();
    const r = await db.execute({
      sql: `INSERT INTO products (name, category, description, sku, sale_price, unit, tracks_inventory, active, created_at, updated_at)
            VALUES (?,?,?,?,?,?,?,?,?,?)`,
      args: [name, category, description||null, sku||null, sale_price||0, unit||'unidad',
             tracks_inventory?1:0, active!==false?1:0, now, now],
    });
    res.json({ id: lastId(r) });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.put('/api/catalog/products/:id', async (req, res) => {
  try {
    // Load existing record so we can validate the final merged state
    const existing = row(await db.execute({ sql: 'SELECT * FROM products WHERE id = ?', args: [req.params.id] }));
    if (!existing) return res.status(404).json({ error: 'Producto no encontrado' });

    const { name, category, description, sku, sale_price, unit, tracks_inventory, active } = req.body;

    // Compute the final values after merging body with existing
    const finalActive = active !== undefined ? Boolean(active) : Boolean(existing.active);
    const finalPrice  = sale_price !== undefined ? Number(sale_price) : Number(existing.sale_price);

    if (finalActive && (!finalPrice || finalPrice <= 0)) {
      return res.status(400).json({ error: 'No se puede activar un producto sin precio válido mayor que cero' });
    }

    const now = isoNow();
    await db.execute({
      sql: `UPDATE products SET
            name=COALESCE(?,name), category=COALESCE(?,category), description=COALESCE(?,description),
            sku=COALESCE(?,sku), sale_price=COALESCE(?,sale_price), unit=COALESCE(?,unit),
            tracks_inventory=COALESCE(?,tracks_inventory), active=?, updated_at=?
            WHERE id=?`,
      args: [name||null, category||null, description||null, sku||null,
             sale_price!=null?sale_price:null, unit||null,
             tracks_inventory!=null?(tracks_inventory?1:0):null,
             finalActive?1:0, now, req.params.id],
    });
    res.json({ ok: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/catalog/variants', async (req, res) => {
  try {
    const { product_id, brand, presentation_kg, valve_type, sku, sale_price, active } = req.body;
    if (!product_id) return res.status(400).json({ error: 'product_id requerido' });

    const product = row(await db.execute({ sql: 'SELECT * FROM products WHERE id = ?', args: [product_id] }));
    if (!product) return res.status(400).json({ error: `Producto id=${product_id} no encontrado` });

    // Normalise valve_type: treat empty string as null
    const normalValve = (valve_type === '' || valve_type === undefined) ? null : valve_type;
    const variantData = { presentation_kg: presentation_kg ?? null, valve_type: normalValve };

    const ruleError = validateVariantRules(product, variantData);
    if (ruleError) return res.status(400).json({ error: ruleError });

    const now = isoNow();
    const r = await db.execute({
      sql: `INSERT INTO product_variants (product_id, brand, presentation_kg, valve_type, sku, sale_price, active, created_at, updated_at)
            VALUES (?,?,?,?,?,?,?,?,?)`,
      args: [product_id, brand||null, presentation_kg??null, normalValve, sku||null,
             sale_price||0, active!==false?1:0, now, now],
    });
    res.json({ id: lastId(r) });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.put('/api/catalog/variants/:id', async (req, res) => {
  try {
    // Load existing variant to merge and validate the final state
    const existing = row(await db.execute({ sql: 'SELECT * FROM product_variants WHERE id = ?', args: [req.params.id] }));
    if (!existing) return res.status(404).json({ error: 'Variante no encontrada' });

    const product = row(await db.execute({ sql: 'SELECT * FROM products WHERE id = ?', args: [existing.product_id] }));
    if (!product) return res.status(404).json({ error: 'Producto padre no encontrado' });

    // Merge: undefined in body → keep existing; explicit value (incl. null) → use it
    const b = req.body;
    const normalValve = b.valve_type !== undefined
      ? (b.valve_type === '' ? null : b.valve_type)
      : existing.valve_type;

    const merged = {
      presentation_kg: b.presentation_kg !== undefined ? b.presentation_kg : existing.presentation_kg,
      valve_type:      normalValve,
    };

    const ruleError = validateVariantRules(product, merged);
    if (ruleError) return res.status(400).json({ error: ruleError });

    // Compute final active + price for the activation guard
    const finalActive = b.active !== undefined ? Boolean(b.active) : Boolean(existing.active);
    const finalPrice  = b.sale_price !== undefined ? Number(b.sale_price) : Number(existing.sale_price);
    if (finalActive && (!finalPrice || finalPrice <= 0)) {
      return res.status(400).json({ error: 'No se puede activar una variante sin precio válido mayor que cero' });
    }

    const now = isoNow();
    await db.execute({
      sql: `UPDATE product_variants SET
            brand=COALESCE(?,brand), presentation_kg=?, valve_type=?, sku=COALESCE(?,sku),
            sale_price=COALESCE(?,sale_price), active=?, updated_at=?
            WHERE id=?`,
      args: [b.brand||null,
             merged.presentation_kg ?? existing.presentation_kg,
             merged.valve_type,          // may be null — set explicitly, not via COALESCE
             b.sku||null, b.sale_price!=null?b.sale_price:null,
             finalActive?1:0, now, req.params.id],
    });
    res.json({ ok: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ─── INVENTORY ────────────────────────────────────────────────────────────────
app.get('/api/inventory/stock', async (req, res) => {
  try {
    res.json(rows(await db.execute({
      sql: `SELECT s.*, p.name as product_name, p.category,
                   pv.brand, pv.presentation_kg, pv.valve_type
            FROM inventory_stock s
            JOIN products p ON s.product_id = p.id
            LEFT JOIN product_variants pv ON s.variant_id = pv.id
            ORDER BY p.category, p.name, pv.presentation_kg, pv.brand`,
      args: [],
    })));
  } catch (err) { res.status(500).json({ error: err.message }); }
});

const ALLOWED_MOVEMENT_TYPES = ['entrada', 'salida', 'merma', 'devolucion', 'ajuste_positivo', 'ajuste_negativo'];
const OUT_MOVEMENT_TYPES     = new Set(['salida', 'merma', 'ajuste_negativo']);

app.post('/api/inventory/adjust', async (req, res) => {
  try {
    const { product_id, variant_id, movement_type, quantity, stock_type, notes, rider_id, order_id } = req.body;

    // ── Input validation ────────────────────────────────────────────────────────
    if (!product_id)    return res.status(400).json({ error: 'product_id requerido' });
    if (!movement_type) return res.status(400).json({ error: 'movement_type requerido' });
    if (!ALLOWED_MOVEMENT_TYPES.includes(movement_type)) {
      return res.status(400).json({ error: `movement_type inválido. Permitidos: ${ALLOWED_MOVEMENT_TYPES.join(', ')}` });
    }
    const qty = parseInt(quantity, 10);
    if (!Number.isFinite(qty) || qty <= 0) {
      return res.status(400).json({ error: 'quantity debe ser un entero mayor que cero' });
    }
    if (!notes || String(notes).trim() === '') {
      return res.status(400).json({ error: 'notes (motivo) es obligatorio para todo ajuste' });
    }

    // ── Referential validation ──────────────────────────────────────────────────
    const product = row(await db.execute({ sql: 'SELECT id FROM products WHERE id = ?', args: [product_id] }));
    if (!product) return res.status(400).json({ error: `Producto id=${product_id} no existe` });

    const vid = variant_id || null;
    if (vid) {
      const variant = row(await db.execute({
        sql: 'SELECT id FROM product_variants WHERE id = ? AND product_id = ?',
        args: [vid, product_id],
      }));
      if (!variant) return res.status(400).json({ error: `Variante id=${vid} no existe o no pertenece al producto ${product_id}` });
    }

    const sType = stock_type || 'disponible';
    const now   = isoNow();

    // H3: fully atomic find-or-create inside a single transaction.
    // INSERT OR IGNORE relies on idx_inventory_stock_unique (product_id, stock_type, COALESCE(variant_id,-1)).
    const tx = await db.transaction('write');
    try {
      await tx.execute({
        sql: `INSERT OR IGNORE INTO inventory_stock (product_id, variant_id, stock_type, quantity, updated_at)
              VALUES (?, ?, ?, 0, ?)`,
        args: [product_id, vid, sType, now],
      });

      const stockRow = row(await tx.execute({
        sql: `SELECT * FROM inventory_stock WHERE product_id=? AND stock_type=? AND (variant_id IS ? OR variant_id=?)`,
        args: [product_id, sType, vid, vid],
      }));

      const stockBefore = stockRow.quantity;
      const isOut       = OUT_MOVEMENT_TYPES.has(movement_type);
      const delta       = isOut ? -qty : qty;
      const stockAfter  = stockBefore + delta;

      if (stockAfter < 0) {
        await tx.rollback();
        return res.status(400).json({
          error: `Operación rechazada: stock disponible es ${stockBefore} y la salida es ${qty} — el resultado sería negativo`,
          stock_before: stockBefore,
        });
      }

      await tx.execute({
        sql: 'UPDATE inventory_stock SET quantity=?, updated_at=? WHERE id=?',
        args: [stockAfter, now, stockRow.id],
      });
      await tx.execute({
        sql: `INSERT INTO inventory_movements
                (product_id, variant_id, movement_type, quantity, stock_before, stock_after,
                 order_id, rider_id, notes, created_at)
              VALUES (?,?,?,?,?,?,?,?,?,?)`,
        args: [product_id, vid, movement_type, qty, stockBefore, stockAfter,
               order_id||null, rider_id||null, String(notes).trim(), now],
      });
      await tx.commit();
      res.json({ stock_before: stockBefore, stock_after: stockAfter });
    } catch (txErr) {
      await tx.rollback();
      throw txErr;
    }
  } catch (err) { res.status(500).json({ error: err.message }); }
});

const MAX_MOVEMENTS_LIMIT = 500;

app.get('/api/inventory/movements', async (req, res) => {
  try {
    const { product_id, variant_id, from, to } = req.query;
    // M6: cap limit to prevent unbounded result sets
    const rawLim = parseInt(req.query.limit) || 100;
    if (rawLim > MAX_MOVEMENTS_LIMIT) {
      return res.status(400).json({ error: `El parámetro limit no puede superar ${MAX_MOVEMENTS_LIMIT}` });
    }
    const lim = rawLim;
    let sql = `SELECT m.*, p.name as product_name, pv.brand, pv.presentation_kg, pv.valve_type
               FROM inventory_movements m
               JOIN products p ON m.product_id = p.id
               LEFT JOIN product_variants pv ON m.variant_id = pv.id WHERE 1=1`;
    const args = [];
    if (product_id) { sql += ` AND m.product_id=?`; args.push(product_id); }
    if (variant_id) { sql += ` AND m.variant_id=?`; args.push(variant_id); }
    if (from)       { sql += ` AND date(m.created_at, '-5 hours') >= ?`; args.push(from); }
    if (to)         { sql += ` AND date(m.created_at, '-5 hours') <= ?`; args.push(to); }
    sql += ` ORDER BY m.created_at DESC LIMIT ?`;
    args.push(lim);
    res.json(rows(await db.execute({ sql, args })));
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ─── DAILY DETAIL REPORT ──────────────────────────────────────────────────────
app.get('/api/reports/daily-detail', async (req, res) => {
  try {
    const d = req.query.date || todayStr();

    // Load orders with client, rider, and payment info in one query
    const orderList = rows(await db.execute({
      sql: `SELECT o.id, o.status, o.payment_method, o.total, o.catalog_version,
                   o.created_at, o.delivered_at,
                   c.name AS client_name, c.address AS client_address, c.zone,
                   r.name AS rider_name,
                   p.destination AS payment_destination,
                   COALESCE(p.status, 'sin_registrar') AS reconciliation_status
            FROM orders o
            LEFT JOIN clients c ON o.client_id = c.id
            LEFT JOIN riders r ON o.rider_id = r.id
            LEFT JOIN payments p ON p.order_id = o.id
            WHERE date(o.created_at, '-5 hours') = ? ORDER BY o.created_at`,
      args: [d],
    }));

    const ids = orderList.map(o => o.id);
    let itemList = [];
    if (ids.length) {
      itemList = rows(await db.execute({
        sql: `SELECT * FROM order_items WHERE order_id IN (${ids.map(() => '?').join(',')})`,
        args: ids,
      }));
    }

    const orders    = orderList.map(o => ({ ...o, items: itemList.filter(i => i.order_id === o.id) }));
    const delivered = orders.filter(o => o.status === 'Entregado');

    // ── Item classifiers (snapshot-first, legacy fallback) ─────────────────────
    const pname  = i => (i.product_name_snapshot || i.product || '').toLowerCase();
    const is10   = i => i.presentation_snapshot === '10 kg' || i.product === 'Balón 10kg';
    const is45   = i => i.presentation_snapshot === '45 kg' || i.product === 'Balón 40kg';
    const isBalloon = i => i.category_snapshot === 'balón' || is10(i) || is45(i);
    const isValv = i => i.category_snapshot === 'válvula' || (pname(i).includes('válvula') && !isBalloon(i));
    const isKit  = i => i.category_snapshot === 'kit'     || pname(i).includes('kit');

    // C2: counters use ONLY items from delivered orders to match revenue denominator
    const deliveredIds    = new Set(delivered.map(o => o.id));
    const deliveredItems  = itemList.filter(i => deliveredIds.has(i.order_id));

    // ── Summary counters ────────────────────────────────────────────────────────
    let b10 = 0, b45 = 0, b10n = 0, b10p = 0;
    const vn  = { quantity: 0, amount: 0 };
    const vp  = { quantity: 0, amount: 0 };
    const kts = { quantity: 0, amount: 0 };
    const oth = { quantity: 0, amount: 0 };
    const brandMap = {};

    for (const i of deliveredItems) {
      const qty = i.quantity || 0;
      const sub = i.subtotal || (qty * (i.unit_price || 0));

      if (isBalloon(i)) {
        if (is10(i)) {
          b10 += qty;
          if (i.valve_type_snapshot === 'normal')  b10n += qty;
          if (i.valve_type_snapshot === 'premium') b10p += qty;
        }
        if (is45(i)) b45 += qty;
        const brand = i.brand_snapshot || 'Sin marca';
        brandMap[brand] = (brandMap[brand] || 0) + qty;
      } else if (isValv(i)) {
        const vtype = i.valve_type_snapshot;
        if (vtype === 'normal'  || pname(i).includes('normal'))  { vn.quantity += qty; vn.amount += sub; }
        else if (vtype === 'premium' || pname(i).includes('premium')) { vp.quantity += qty; vp.amount += sub; }
      } else if (isKit(i)) {
        kts.quantity += qty; kts.amount += sub;
      } else {
        oth.quantity += qty; oth.amount += sub;
      }
    }

    // Balones solicitados: total en todos los pedidos no cancelados (no solo entregados)
    const activeOrderIds = new Set(orders.filter(o => o.status !== 'Cancelado').map(o => o.id));
    const balloonsRequested = itemList
      .filter(i => activeOrderIds.has(i.order_id) && isBalloon(i))
      .reduce((s, i) => s + (i.quantity || 0), 0);

    const summary = {
      date:         d,
      total_orders: orders.length,
      delivered:    delivered.length,
      pending:      orders.filter(o => o.status === 'Pendiente').length,
      in_transit:   orders.filter(o => o.status === 'En camino').length,
      cancelled:    orders.filter(o => o.status === 'Cancelado').length,
      revenue:      delivered.reduce((s, o) => s + (o.total || 0), 0),
      balloons_10:  b10,
      balloons_45:  b45,
      balloons_requested: balloonsRequested,
      balloons_10_normal:  b10n,
      balloons_10_premium: b10p,
      valvulas_normal_individuales:  vn,
      valvulas_premium_individuales: vp,
      kits:          kts,
      otros_productos: oth,
      by_brand: Object.entries(brandMap).map(([brand, quantity]) => ({ brand, quantity })),
      // H5: dynamic — reflects whatever payment methods appear in delivered orders,
      // no hardcoded list means no missing methods and no phantom Plin entries.
      by_payment: delivered.reduce((acc, o) => {
        const pm = o.payment_method || 'Sin método';
        acc[pm] = (acc[pm] || 0) + (o.total || 0);
        return acc;
      }, {}),
      by_rider: Object.values(
        delivered.reduce((acc, o) => {
          const k = o.rider_name || 'Sin asignar';
          if (!acc[k]) acc[k] = { rider_name: k, orders: 0, revenue: 0, balloons: 0 };
          acc[k].orders++;
          acc[k].revenue  += o.total || 0;
          acc[k].balloons += deliveredItems.filter(i => i.order_id === o.id && isBalloon(i))
                                           .reduce((s, i) => s + (i.quantity || 0), 0);
          return acc;
        }, {})
      ),
    };

    res.json({ summary, orders });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ─── CONFIG ───────────────────────────────────────────────────────────────────
app.get('/api/config', async (req, res) => {
  try { res.json(await getConfig()); }
  catch (err) { res.status(500).json({ error: err.message }); }
});

app.put('/api/config', async (req, res) => {
  try {
    await Promise.all(
      Object.entries(req.body).map(([k, v]) =>
        db.execute({ sql: 'INSERT OR REPLACE INTO config (key, value) VALUES (?, ?)', args: [k, String(v)] })
      )
    );
    res.json({ ok: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ─── PAYMENTS ────────────────────────────────────────────────────────────────

const VALID_PAYMENT_METHODS  = ['yape', 'efectivo', 'tarjeta', 'transferencia'];
const VALID_CONFIRMED_BY     = ['luis', 'gisela', 'admin'];
const VALID_HANDED_TO        = ['luis', 'gisela'];

const DESTINATIONS_BY_METHOD = {
  efectivo:      ['efectivo_motorizado'],
  yape:          ['yape_luis', 'yape_gisela'],
  tarjeta:       ['pos_lm'],
  transferencia: ['bcp_lm', 'bcp_luis', 'bcp_gisela', 'bbva_lm', 'otro'],
};

function validateMethodDestination(method, destination) {
  if (!VALID_PAYMENT_METHODS.includes(method)) {
    return `method inválido: '${method}'. Valores: ${VALID_PAYMENT_METHODS.join(', ')}`;
  }
  const valid = DESTINATIONS_BY_METHOD[method] || [];
  if (!valid.includes(destination)) {
    return `destination '${destination}' no es válida para method '${method}'. Válidas: ${valid.join(', ')}`;
  }
  return null;
}

async function insertPaymentEvent({ paymentId, cashHandoverId = null, eventType, previousStatus = null, newStatus = null, performedBy = null, notes = null }) {
  await db.execute({
    sql: `INSERT INTO payment_events (payment_id, cash_handover_id, event_type, previous_status, new_status, performed_by, notes, created_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    args: [paymentId, cashHandoverId, eventType, previousStatus, newStatus, performedBy, notes, isoNow()],
  });
}

// POST /api/orders/:id/payments
app.post('/api/orders/:id/payments', async (req, res) => {
  try {
    const orderId = Number(req.params.id);
    const { amount, method, destination, operation_number, notes, client_request_id } = req.body;

    const order = row(await db.execute({
      sql: 'SELECT id, total, rider_id, status FROM orders WHERE id = ?',
      args: [orderId],
    }));
    if (!order) return res.status(404).json({ error: 'Pedido no encontrado' });

    // Idempotency: same client_request_id → return existing
    if (client_request_id) {
      const dup = row(await db.execute({
        sql: 'SELECT * FROM payments WHERE client_request_id = ?',
        args: [client_request_id],
      }));
      if (dup) {
        const handover = row(await db.execute({
          sql: 'SELECT * FROM cash_handovers WHERE payment_id = ?',
          args: [dup.id],
        }));
        return res.json({ payment: dup, cash_handover: handover });
      }
    }

    const amt = Number(amount);
    if (!amt || amt <= 0) return res.status(400).json({ error: 'amount debe ser mayor que cero' });
    if (amt > order.total + 0.001) {
      return res.status(400).json({ error: `amount (${amt}) supera el total del pedido (${order.total})` });
    }

    const methodErr = validateMethodDestination(method, destination);
    if (methodErr) return res.status(400).json({ error: methodErr });

    const existing = row(await db.execute({
      sql: 'SELECT id, status FROM payments WHERE order_id = ?',
      args: [orderId],
    }));
    if (existing) {
      return res.status(409).json({
        error: 'Ya existe un pago para este pedido',
        payment_id: existing.id,
        payment_status: existing.status,
      });
    }

    if (method === 'efectivo' && !order.rider_id) {
      return res.status(400).json({
        error: 'No se puede registrar pago en efectivo: el pedido no tiene motorizado asignado',
        code: 'NO_RIDER',
      });
    }

    const now = isoNow();

    const payResult = await db.execute({
      sql: `INSERT INTO payments
              (order_id, amount, method, destination, operation_number, status,
               reported_by, reported_at, notes, client_request_id, created_at, updated_at)
            VALUES (?, ?, ?, ?, ?, 'reportado', 'admin', ?, ?, ?, ?, ?)`,
      args: [orderId, amt, method, destination, operation_number || null,
             now, notes || null, client_request_id || null, now, now],
    });
    const paymentId = lastId(payResult);

    await insertPaymentEvent({
      paymentId,
      eventType: 'pago_registrado',
      newStatus: 'reportado',
      performedBy: 'admin',
      notes: `${method} → ${destination}${operation_number ? ` op:${operation_number}` : ''}`,
    });

    let handover = null;

    if (method === 'efectivo') {
      const hResult = await db.execute({
        sql: `INSERT INTO cash_handovers (payment_id, rider_id, amount, status, created_at, updated_at)
              VALUES (?, ?, ?, 'en_poder_motorizado', ?, ?)`,
        args: [paymentId, order.rider_id, amt, now, now],
      });
      const handoverId = lastId(hResult);

      await insertPaymentEvent({
        paymentId,
        cashHandoverId: handoverId,
        eventType: 'efectivo_en_poder_motorizado',
        newStatus: 'en_poder_motorizado',
        performedBy: 'admin',
      });

      handover = row(await db.execute({
        sql: 'SELECT * FROM cash_handovers WHERE id = ?',
        args: [handoverId],
      }));
    }

    const payment = row(await db.execute({
      sql: 'SELECT * FROM payments WHERE id = ?',
      args: [paymentId],
    }));

    res.status(201).json({ payment, cash_handover: handover });
  } catch (err) {
    if (err.message?.includes('UNIQUE constraint failed: payments.order_id')) {
      return res.status(409).json({ error: 'Ya existe un pago para este pedido' });
    }
    if (err.message?.includes('UNIQUE constraint failed: payments.client_request_id')) {
      return res.status(409).json({ error: 'client_request_id ya utilizado' });
    }
    res.status(500).json({ error: err.message });
  }
});

// GET /api/orders/:id/payments
app.get('/api/orders/:id/payments', async (req, res) => {
  try {
    const orderId = Number(req.params.id);
    const payment = row(await db.execute({
      sql: 'SELECT * FROM payments WHERE order_id = ?',
      args: [orderId],
    }));

    if (!payment) return res.json({ payment: null, cash_handover: null, events: [] });

    const handover = row(await db.execute({
      sql: 'SELECT * FROM cash_handovers WHERE payment_id = ?',
      args: [payment.id],
    }));

    const events = rows(await db.execute({
      sql: 'SELECT * FROM payment_events WHERE payment_id = ? ORDER BY created_at ASC',
      args: [payment.id],
    }));

    res.json({ payment, cash_handover: handover, events });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// PATCH /api/payments/:id/confirm
app.patch('/api/payments/:id/confirm', async (req, res) => {
  try {
    const paymentId = Number(req.params.id);
    const { confirmed_by } = req.body;

    if (!VALID_CONFIRMED_BY.includes(confirmed_by)) {
      return res.status(400).json({ error: `confirmed_by inválido. Valores: ${VALID_CONFIRMED_BY.join(', ')}` });
    }

    const payment = row(await db.execute({
      sql: 'SELECT * FROM payments WHERE id = ?',
      args: [paymentId],
    }));
    if (!payment) return res.status(404).json({ error: 'Pago no encontrado' });

    if (payment.status === 'confirmado') {
      return res.json({ payment, message: 'Ya confirmado' });
    }

    if (payment.status === 'rechazado') {
      return res.status(409).json({ error: 'No se puede confirmar un pago rechazado' });
    }

    if (payment.method === 'efectivo') {
      const handover = row(await db.execute({
        sql: 'SELECT status FROM cash_handovers WHERE payment_id = ?',
        args: [paymentId],
      }));
      if (!handover || handover.status !== 'confirmado') {
        return res.status(409).json({
          error: 'El pago en efectivo requiere que la rendición del motorizado esté confirmada primero',
          code: 'HANDOVER_NOT_CONFIRMED',
          handover_status: handover?.status || null,
        });
      }
    }

    const now = isoNow();
    await db.execute({
      sql: `UPDATE payments SET status = 'confirmado', confirmed_by = ?, confirmed_at = ?, updated_at = ? WHERE id = ?`,
      args: [confirmed_by, now, now, paymentId],
    });

    await insertPaymentEvent({
      paymentId,
      eventType: 'pago_confirmado',
      previousStatus: payment.status,
      newStatus: 'confirmado',
      performedBy: confirmed_by,
    });

    const updated = row(await db.execute({ sql: 'SELECT * FROM payments WHERE id = ?', args: [paymentId] }));
    res.json({ payment: updated });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// PATCH /api/payments/:id/reject
app.patch('/api/payments/:id/reject', async (req, res) => {
  try {
    const paymentId = Number(req.params.id);
    const { confirmed_by, reason } = req.body;

    if (!reason || !String(reason).trim()) {
      return res.status(400).json({ error: 'reason es obligatorio' });
    }
    if (!VALID_CONFIRMED_BY.includes(confirmed_by)) {
      return res.status(400).json({ error: `confirmed_by inválido. Valores: ${VALID_CONFIRMED_BY.join(', ')}` });
    }

    const payment = row(await db.execute({
      sql: 'SELECT * FROM payments WHERE id = ?',
      args: [paymentId],
    }));
    if (!payment) return res.status(404).json({ error: 'Pago no encontrado' });

    if (payment.status === 'confirmado') {
      return res.status(409).json({
        error: 'No se puede rechazar un pago ya confirmado. Se requiere un flujo de reversión.',
        code: 'ALREADY_CONFIRMED',
      });
    }

    const now = isoNow();
    await db.execute({
      sql: `UPDATE payments SET status = 'rechazado', confirmed_by = ?, confirmed_at = ?, rejection_reason = ?, updated_at = ? WHERE id = ?`,
      args: [confirmed_by, now, String(reason).trim(), now, paymentId],
    });

    await insertPaymentEvent({
      paymentId,
      eventType: 'pago_rechazado',
      previousStatus: payment.status,
      newStatus: 'rechazado',
      performedBy: confirmed_by,
      notes: String(reason).trim(),
    });

    const updated = row(await db.execute({ sql: 'SELECT * FROM payments WHERE id = ?', args: [paymentId] }));
    res.json({ payment: updated });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// PATCH /api/cash-handovers/:id/handover
app.patch('/api/cash-handovers/:id/handover', async (req, res) => {
  try {
    const handoverId = Number(req.params.id);
    const { handed_to } = req.body;

    if (!VALID_HANDED_TO.includes(handed_to)) {
      return res.status(400).json({ error: `handed_to inválido. Valores: ${VALID_HANDED_TO.join(', ')}` });
    }

    const handover = row(await db.execute({
      sql: 'SELECT * FROM cash_handovers WHERE id = ?',
      args: [handoverId],
    }));
    if (!handover) return res.status(404).json({ error: 'Rendición no encontrada' });

    if (handover.status === 'entregado_administracion') {
      return res.json({ cash_handover: handover, message: 'Ya registrada la entrega' });
    }

    if (handover.status !== 'en_poder_motorizado') {
      return res.status(409).json({
        error: `Transición inválida desde estado '${handover.status}'`,
        code: 'INVALID_TRANSITION',
      });
    }

    const now = isoNow();
    await db.execute({
      sql: `UPDATE cash_handovers
            SET status = 'entregado_administracion', handed_to = ?, handed_by = 'admin', handed_at = ?, updated_at = ?
            WHERE id = ?`,
      args: [handed_to, now, now, handoverId],
    });

    await insertPaymentEvent({
      paymentId: handover.payment_id,
      cashHandoverId: handoverId,
      eventType: 'efectivo_entregado_administracion',
      previousStatus: 'en_poder_motorizado',
      newStatus: 'entregado_administracion',
      performedBy: 'admin',
      notes: `Entregado a: ${handed_to}`,
    });

    const updated = row(await db.execute({ sql: 'SELECT * FROM cash_handovers WHERE id = ?', args: [handoverId] }));
    res.json({ cash_handover: updated });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// PATCH /api/cash-handovers/:id/confirm
app.patch('/api/cash-handovers/:id/confirm', async (req, res) => {
  try {
    const handoverId = Number(req.params.id);
    const { confirmed_by } = req.body;

    if (!VALID_HANDED_TO.includes(confirmed_by)) {
      return res.status(400).json({ error: `confirmed_by inválido para rendición. Solo: ${VALID_HANDED_TO.join(', ')}` });
    }

    const handover = row(await db.execute({
      sql: 'SELECT * FROM cash_handovers WHERE id = ?',
      args: [handoverId],
    }));
    if (!handover) return res.status(404).json({ error: 'Rendición no encontrada' });

    if (handover.status === 'confirmado') {
      const payment = row(await db.execute({ sql: 'SELECT * FROM payments WHERE id = ?', args: [handover.payment_id] }));
      return res.json({ cash_handover: handover, payment, message: 'Ya confirmado' });
    }

    if (handover.status !== 'entregado_administracion') {
      return res.status(409).json({
        error: `Solo se puede confirmar desde 'entregado_administracion'. Estado actual: '${handover.status}'`,
        code: 'INVALID_TRANSITION',
      });
    }

    const now = isoNow();

    await db.execute({
      sql: `UPDATE cash_handovers SET status = 'confirmado', confirmed_by = ?, confirmed_at = ?, updated_at = ? WHERE id = ?`,
      args: [confirmed_by, now, now, handoverId],
    });

    await insertPaymentEvent({
      paymentId: handover.payment_id,
      cashHandoverId: handoverId,
      eventType: 'efectivo_recibido_confirmado',
      previousStatus: 'entregado_administracion',
      newStatus: 'confirmado',
      performedBy: confirmed_by,
    });

    const payment = row(await db.execute({ sql: 'SELECT * FROM payments WHERE id = ?', args: [handover.payment_id] }));

    if (payment && payment.status !== 'confirmado') {
      await db.execute({
        sql: `UPDATE payments SET status = 'confirmado', confirmed_by = ?, confirmed_at = ?, updated_at = ? WHERE id = ?`,
        args: [confirmed_by, now, now, payment.id],
      });

      await insertPaymentEvent({
        paymentId: payment.id,
        cashHandoverId: handoverId,
        eventType: 'pago_confirmado',
        previousStatus: payment.status,
        newStatus: 'confirmado',
        performedBy: confirmed_by,
        notes: 'Confirmado al confirmar rendición de efectivo',
      });
    }

    const updatedHandover = row(await db.execute({ sql: 'SELECT * FROM cash_handovers WHERE id = ?', args: [handoverId] }));
    const updatedPayment  = row(await db.execute({ sql: 'SELECT * FROM payments WHERE id = ?', args: [handover.payment_id] }));
    res.json({ cash_handover: updatedHandover, payment: updatedPayment });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/reports/payments-summary
app.get('/api/reports/payments-summary', async (req, res) => {
  try {
    let { date } = req.query;
    if (!date) {
      // Default: today in Lima (UTC-5)
      const d = new Date(Date.now() - 5 * 60 * 60 * 1000);
      date = d.toISOString().slice(0, 10);
    }

    // Delivered orders for this date (Lima = UTC-5)
    const deliveredOrders = rows(await db.execute({
      sql: `SELECT o.id, o.total, o.rider_id, r.name as rider_name
            FROM orders o
            LEFT JOIN riders r ON o.rider_id = r.id
            WHERE o.status = 'Entregado'
              AND date(o.delivered_at, '-5 hours') = ?`,
      args: [date],
    }));

    const orderIds      = deliveredOrders.map(o => o.id);
    const totalVendido  = deliveredOrders.reduce((s, o) => s + (o.total || 0), 0);
    const pedidosEntregados = deliveredOrders.length;

    let payments = [];
    if (orderIds.length > 0) {
      const ph = orderIds.map(() => '?').join(',');
      payments = rows(await db.execute({
        sql: `SELECT p.*, ch.status as handover_status, ch.rider_id as handover_rider_id
              FROM payments p
              LEFT JOIN cash_handovers ch ON ch.payment_id = p.id
              WHERE p.order_id IN (${ph})
                AND p.status != 'rechazado'`,
        args: orderIds,
      }));
    }

    const pedidosSinPago    = orderIds.filter(id => !payments.find(p => p.order_id === id)).length;
    const totalReportado    = payments.reduce((s, p) => s + (p.amount || 0), 0);
    const totalConfirmado   = payments.filter(p => p.status === 'confirmado').reduce((s, p) => s + (p.amount || 0), 0);
    const totalPorConfirmar = payments.filter(p => p.status === 'reportado').reduce((s, p) => s + (p.amount || 0), 0);

    const sumBy  = (arr, field, val) => arr.filter(p => p[field] === val).reduce((s, p) => s + (p.amount || 0), 0);
    const sumAll = (arr) => arr.reduce((s, p) => s + (p.amount || 0), 0);

    const yape          = payments.filter(p => p.method === 'yape');
    const efectivo      = payments.filter(p => p.method === 'efectivo');
    const tarjeta       = payments.filter(p => p.method === 'tarjeta');
    const transferencia = payments.filter(p => p.method === 'transferencia');

    // Efectivo per-rider breakdown
    const riderMap = {};
    for (const o of deliveredOrders) {
      if (o.rider_id && !riderMap[o.rider_id]) {
        riderMap[o.rider_id] = { rider_id: o.rider_id, rider_name: o.rider_name, en_poder: 0, entregado: 0, confirmado: 0 };
      }
    }
    for (const p of efectivo) {
      const r = p.handover_rider_id;
      if (r && riderMap[r]) {
        if (p.handover_status === 'en_poder_motorizado')       riderMap[r].en_poder   += p.amount || 0;
        else if (p.handover_status === 'entregado_administracion') riderMap[r].entregado += p.amount || 0;
        else if (p.handover_status === 'confirmado')           riderMap[r].confirmado += p.amount || 0;
      }
    }

    res.json({
      date,
      total_vendido:       totalVendido,
      total_reportado:     totalReportado,
      total_confirmado:    totalConfirmado,
      total_por_confirmar: totalPorConfirmar,
      pedidos_entregados:  pedidosEntregados,
      pedidos_sin_pago:    pedidosSinPago,
      por_metodo: {
        yape: {
          yape_luis:   sumBy(yape, 'destination', 'yape_luis'),
          yape_gisela: sumBy(yape, 'destination', 'yape_gisela'),
          total:       sumAll(yape),
        },
        efectivo: {
          en_poder_motorizados:     sumBy(efectivo, 'handover_status', 'en_poder_motorizado'),
          entregado_administracion: sumBy(efectivo, 'handover_status', 'entregado_administracion'),
          confirmado:               sumBy(efectivo, 'handover_status', 'confirmado'),
          total:                    sumAll(efectivo),
        },
        tarjeta: {
          pos_lm: sumBy(tarjeta, 'destination', 'pos_lm'),
          total:  sumAll(tarjeta),
        },
        transferencia: {
          bcp_lm:    sumBy(transferencia, 'destination', 'bcp_lm'),
          bcp_luis:  sumBy(transferencia, 'destination', 'bcp_luis'),
          bcp_gisela: sumBy(transferencia, 'destination', 'bcp_gisela'),
          bbva_lm:   sumBy(transferencia, 'destination', 'bbva_lm'),
          otro:      sumBy(transferencia, 'destination', 'otro'),
          total:     sumAll(transferencia),
        },
      },
      efectivo_por_motorizado: Object.values(riderMap),
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Local dev entry point
if (require.main === module) {
  const PORT = process.env.PORT || 3001;
  app.listen(PORT, () => console.log(`✅ L&M Gas CRM corriendo en http://localhost:${PORT}`));
}

module.exports = app;
