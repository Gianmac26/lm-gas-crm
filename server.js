const express = require('express');
const { createClient } = require('@libsql/client');
const cors = require('cors');
const ExcelJS = require('exceljs');

const app = express();

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
              created_at         DATETIME DEFAULT CURRENT_TIMESTAMP
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
    { sql: `CREATE TABLE IF NOT EXISTS wa_messages (
              id          INTEGER PRIMARY KEY AUTOINCREMENT,
              client_id   INTEGER,
              phone       TEXT,
              message     TEXT,
              received_at DATETIME DEFAULT CURRENT_TIMESTAMP,
              FOREIGN KEY (client_id) REFERENCES clients(id)
            )`, args: [] },
  ], 'write');

  const defaults = {
    pin: '1234', daily_goal: '80', price_10kg: '38', price_40kg: '120',
    price_water: '12', price_cleaning: '15',
    zones: 'San Borja,Surco,Miraflores,Otra', dark_mode: 'false',
  };
  await Promise.all(
    Object.entries(defaults).map(([k, v]) =>
      db.execute({ sql: 'INSERT OR IGNORE INTO config (key, value) VALUES (?, ?)', args: [k, v] })
    )
  );
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

function todayStr() {
  return new Date().toISOString().slice(0, 10);
}

function rows(result) { return result.rows; }
function row(result)  { return result.rows[0] ?? null; }
function lastId(result) { return Number(result.lastInsertRowid); }

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
  // Responder 200 inmediatamente (Meta requiere respuesta rápida)
  res.sendStatus(200);

  try {
    const entry   = req.body?.entry?.[0];
    const change  = entry?.changes?.[0]?.value;
    const msgData = change?.messages?.[0];
    if (!msgData) return;

    const phone   = msgData.from;
    const name    = change.contacts?.[0]?.profile?.name || phone;
    const text    = msgData.text?.body || '';

    // Buscar cliente por teléfono
    const existing = row(await db.execute({
      sql:  'SELECT id FROM clients WHERE phone = ? LIMIT 1',
      args: [phone],
    }));

    let clientId;
    if (existing) {
      clientId = existing.id;
    } else {
      // Crear nuevo cliente desde WhatsApp
      const r = await db.execute({
        sql:  `INSERT INTO clients (name, phone, notes) VALUES (?, ?, ?)`,
        args: [name, phone, 'Contacto vía WhatsApp'],
      });
      clientId = lastId(r);
    }

    // Guardar mensaje en historial
    await db.execute({
      sql:  'INSERT INTO wa_messages (client_id, phone, message) VALUES (?, ?, ?)',
      args: [clientId, phone, text],
    });
  } catch (err) {
    console.error('Error procesando webhook WhatsApp:', err);
  }
});

// ─── AUTH ─────────────────────────────────────────────────────────────────────
app.post('/api/auth/verify', async (req, res) => {
  try {
    const { pin } = req.body;
    const cfg = await getConfig();
    res.json({ ok: pin === cfg.pin });
  } catch (err) { res.status(500).json({ error: err.message }); }
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
            WHERE date(o.created_at) = ?`,
      args: [today],
    }));

    const deliveredToday = todayOrders.filter(o => o.status === 'Entregado');

    const items = rows(await db.execute({
      sql: `SELECT oi.* FROM order_items oi
            JOIN orders o ON oi.order_id = o.id
            WHERE date(o.created_at) = ? AND o.status = 'Entregado'`,
      args: [today],
    }));

    const balloons_10  = items.filter(i => i.product === 'Balón 10kg').reduce((s, i) => s + i.quantity, 0);
    const balloons_40  = items.filter(i => i.product === 'Balón 40kg').reduce((s, i) => s + i.quantity, 0);
    const balloonsToday = balloons_10 + balloons_40;
    const revenueToday  = deliveredToday.reduce((s, o) => s + (o.total || 0), 0);
    const pendingOrders = todayOrders.filter(o => o.status === 'Pendiente' || o.status === 'En camino');

    const lastWeek = new Date();
    lastWeek.setDate(lastWeek.getDate() - 7);
    const lastWeekStr = lastWeek.toISOString().slice(0, 10);

    const lastWeekItems = rows(await db.execute({
      sql: `SELECT oi.* FROM order_items oi
            JOIN orders o ON oi.order_id = o.id
            WHERE date(o.created_at) = ? AND o.status = 'Entregado'
              AND (oi.product = 'Balón 10kg' OR oi.product = 'Balón 40kg')`,
      args: [lastWeekStr],
    }));
    const balloonsLastWeek = lastWeekItems.reduce((s, i) => s + i.quantity, 0);

    const revenueLastWeekRow = row(await db.execute({
      sql:  `SELECT COALESCE(SUM(total),0) as total FROM orders WHERE date(created_at) = ? AND status = 'Entregado'`,
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
    const r = await db.execute({
      sql:  `INSERT INTO clients (name, address, reference, zone, phone, type, business_type, preferred_balloon, purchase_frequency, notes, is_vip)
             VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
      args: [name, address, reference, zone || 'Otra', phone, type || 'Residencial', business_type, preferred_balloon || '10kg', purchase_frequency || 'irregular', notes, is_vip ? 1 : 0],
    });
    res.json({ id: lastId(r) });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.put('/api/clients/:id', async (req, res) => {
  try {
    const { name, address, reference, zone, phone, type, business_type, preferred_balloon, purchase_frequency, notes, is_vip, debt } = req.body;
    await db.execute({
      sql:  `UPDATE clients SET name=?, address=?, reference=?, zone=?, phone=?, type=?, business_type=?,
             preferred_balloon=?, purchase_frequency=?, notes=?, is_vip=?, debt=? WHERE id=?`,
      args: [name, address, reference, zone, phone, type, business_type, preferred_balloon, purchase_frequency, notes, is_vip ? 1 : 0, debt || 0, req.params.id],
    });
    res.json({ ok: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.delete('/api/clients/:id', async (req, res) => {
  try {
    await db.execute({ sql: 'DELETE FROM clients WHERE id = ?', args: [req.params.id] });
    res.json({ ok: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
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
               WHERE date(o.created_at) = ?`;
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

app.post('/api/orders', async (req, res) => {
  try {
    const { client_id, rider_id, payment_method, notes, items } = req.body;
    const total = (items || []).reduce((s, i) => s + (i.quantity * i.unit_price), 0);

    const r = await db.execute({
      sql:  `INSERT INTO orders (client_id, rider_id, payment_method, notes, total) VALUES (?,?,?,?,?)`,
      args: [client_id, rider_id, payment_method || 'Efectivo', notes, total],
    });
    const orderId = lastId(r);

    await Promise.all((items || []).map(item =>
      db.execute({
        sql:  `INSERT INTO order_items (order_id, product, description, quantity, unit_price, subtotal) VALUES (?,?,?,?,?,?)`,
        args: [orderId, item.product, item.description || '', item.quantity, item.unit_price, item.quantity * item.unit_price],
      })
    ));

    if (payment_method === 'Fiado' && client_id) {
      await db.execute({ sql: 'UPDATE clients SET debt = debt + ? WHERE id = ?', args: [total, client_id] });
    }
    res.json({ id: orderId });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.put('/api/orders/:id', async (req, res) => {
  try {
    const { status, rider_id, payment_method, notes, items } = req.body;
    const existing = row(await db.execute({ sql: 'SELECT * FROM orders WHERE id = ?', args: [req.params.id] }));
    if (!existing) return res.status(404).json({ error: 'No encontrado' });

    const total       = items ? items.reduce((s, i) => s + (i.quantity * i.unit_price), 0) : existing.total;
    const deliveredAt = status === 'Entregado' && existing.status !== 'Entregado'
      ? new Date().toISOString()
      : existing.delivered_at;

    await db.execute({
      sql:  `UPDATE orders SET status=?, rider_id=?, payment_method=?, notes=?, total=?, delivered_at=? WHERE id=?`,
      args: [status ?? existing.status, rider_id ?? existing.rider_id, payment_method ?? existing.payment_method, notes ?? existing.notes, total, deliveredAt, req.params.id],
    });

    if (items) {
      await db.execute({ sql: 'DELETE FROM order_items WHERE order_id = ?', args: [req.params.id] });
      await Promise.all(items.map(item =>
        db.execute({
          sql:  `INSERT INTO order_items (order_id, product, description, quantity, unit_price, subtotal) VALUES (?,?,?,?,?,?)`,
          args: [req.params.id, item.product, item.description || '', item.quantity, item.unit_price, item.quantity * item.unit_price],
        })
      ));
    }
    res.json({ ok: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.patch('/api/orders/:id/status', async (req, res) => {
  try {
    const { status } = req.body;
    const existing = row(await db.execute({ sql: 'SELECT * FROM orders WHERE id = ?', args: [req.params.id] }));
    if (!existing) return res.status(404).json({ error: 'No encontrado' });
    const deliveredAt = status === 'Entregado' ? new Date().toISOString() : existing.delivered_at;
    await db.execute({ sql: 'UPDATE orders SET status=?, delivered_at=? WHERE id=?', args: [status, deliveredAt, req.params.id] });
    res.json({ ok: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.delete('/api/orders/:id', async (req, res) => {
  try {
    await db.execute({ sql: 'DELETE FROM order_items WHERE order_id = ?', args: [req.params.id] });
    await db.execute({ sql: 'DELETE FROM orders WHERE id = ?', args: [req.params.id] });
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
        db.execute({ sql: `SELECT COUNT(*) as cnt FROM orders WHERE rider_id=? AND date(created_at)=?`,           args: [rider.id, today] }),
        db.execute({ sql: `SELECT COUNT(*) as cnt FROM orders WHERE rider_id=? AND date(created_at)=? AND status='Entregado'`, args: [rider.id, today] }),
        db.execute({ sql: `SELECT oi.quantity FROM order_items oi JOIN orders o ON oi.order_id=o.id
                           WHERE o.rider_id=? AND o.status='Entregado' AND date(o.created_at)>=?
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
            WHERE o.rider_id=? AND date(o.created_at)=? ORDER BY o.created_at DESC`,
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
    let dateGroup;
    if (group_by === 'week')  dateGroup = `strftime('%Y-W%W', o.created_at)`;
    else if (group_by === 'month') dateGroup = `strftime('%Y-%m', o.created_at)`;
    else dateGroup = `date(o.created_at)`;
    const sales = rows(await db.execute({
      sql: `SELECT ${dateGroup} as period,
              COUNT(DISTINCT o.id) as orders,
              COALESCE(SUM(o.total), 0) as revenue,
              COALESCE(SUM(CASE WHEN oi.product='Balón 10kg' THEN oi.quantity ELSE 0 END), 0) as balloons_10,
              COALESCE(SUM(CASE WHEN oi.product='Balón 40kg' THEN oi.quantity ELSE 0 END), 0) as balloons_40,
              COALESCE(SUM(CASE WHEN oi.product='Agua bidón 20L' THEN oi.quantity ELSE 0 END), 0) as water
            FROM orders o
            LEFT JOIN order_items oi ON oi.order_id = o.id
            WHERE date(o.created_at) BETWEEN ? AND ? AND o.status = 'Entregado'
            GROUP BY period ORDER BY period`,
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
      sql: `SELECT c.zone, COUNT(DISTINCT o.id) as orders, COALESCE(SUM(o.total),0) as revenue,
              COALESCE(SUM(CASE WHEN oi.product LIKE 'Balón%' THEN oi.quantity ELSE 0 END),0) as balloons
            FROM orders o JOIN clients c ON o.client_id=c.id
            LEFT JOIN order_items oi ON oi.order_id=o.id
            WHERE date(o.created_at) BETWEEN ? AND ? AND o.status='Entregado'
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
            WHERE date(o.created_at) BETWEEN ? AND ? AND o.status='Entregado'
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
      sql: `SELECT r.name, r.id as rider_id, COUNT(DISTINCT o.id) as orders,
              COALESCE(SUM(o.total),0) as revenue,
              COALESCE(SUM(CASE WHEN oi.product LIKE 'Balón%' THEN oi.quantity ELSE 0 END),0) as balloons
            FROM orders o JOIN riders r ON o.rider_id=r.id
            LEFT JOIN order_items oi ON oi.order_id=o.id
            WHERE date(o.created_at) BETWEEN ? AND ? AND o.status='Entregado'
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
      sql: `SELECT c.id, c.name, c.phone, c.zone, c.is_vip,
              COUNT(DISTINCT o.id) as orders, COALESCE(SUM(o.total),0) as revenue,
              COALESCE(SUM(CASE WHEN oi.product LIKE 'Balón%' THEN oi.quantity ELSE 0 END),0) as balloons
            FROM clients c JOIN orders o ON o.client_id=c.id
            LEFT JOIN order_items oi ON oi.order_id=o.id
            WHERE date(o.created_at) BETWEEN ? AND ? AND o.status='Entregado'
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
      sql:  `SELECT COALESCE(AVG(total),0) as avg_ticket, COUNT(*) as orders, COALESCE(SUM(total),0) as total FROM orders WHERE date(created_at) BETWEEN ? AND ? AND status='Entregado'`,
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

const path = require('path');
const fs = require('fs');
const distPath = path.join(__dirname, 'client', 'dist');

if (fs.existsSync(distPath)) {
  app.use(express.static(distPath));
  app.get('*', (req, res, next) => {
    if (req.path.startsWith('/api') || req.path.startsWith('/webhook')) {
      return next();
    }
    res.sendFile(path.join(distPath, 'index.html'));
  });
}

// Local dev entry point
if (require.main === module) {
  const PORT = process.env.PORT || 3001;
  app.listen(PORT, () => console.log(`✅ L&M Gas CRM corriendo en http://localhost:${PORT}`));
}

module.exports = app;
