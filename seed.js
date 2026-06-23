require('dotenv').config();
const { createClient } = require('@libsql/client');

const db = createClient({
  url:       process.env.TURSO_DATABASE_URL || 'file:./database/lm_gas.db',
  authToken: process.env.TURSO_AUTH_TOKEN,
});

function normalizePhone(value) {
  const digits = String(value || '').replace(/[+\s\-()]/g, '').replace(/\D/g, '');
  if (!digits) return '';
  if (/^9\d{8}$/.test(digits)) return `51${digits}`;
  if (/^51\d{9}$/.test(digits) && digits.length === 11) return digits;
  return digits;
}

function rows(result) { return result.rows; }
function row(result) { return result.rows[0] ?? null; }
function lastId(result) { return Number(result.lastInsertRowid); }

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

async function getOrCreateConversation({ phone, phoneNormalized, clientId, contactName }) {
  const normalized = phoneNormalized || normalizePhone(phone);
  if (!normalized) return null;

  const now = new Date().toISOString();
  await db.execute({
    sql: `INSERT INTO wa_conversations
            (client_id, phone, phone_normalized, contact_name, status, created_at, updated_at)
          VALUES (?, ?, ?, ?, 'open', ?, ?)
          ON CONFLICT(phone_normalized) DO UPDATE SET
            client_id = COALESCE(wa_conversations.client_id, excluded.client_id),
            phone = COALESCE(NULLIF(excluded.phone, ''), wa_conversations.phone),
            contact_name = COALESCE(NULLIF(excluded.contact_name, ''), wa_conversations.contact_name),
            updated_at = excluded.updated_at`,
    args: [clientId || null, phone || normalized, normalized, contactName || null, now, now],
  });

  return row(await db.execute({
    sql: 'SELECT * FROM wa_conversations WHERE phone_normalized = ? LIMIT 1',
    args: [normalized],
  }));
}

async function ensureSchema() {
  await db.batch([
    { sql: `CREATE TABLE IF NOT EXISTS config (key TEXT PRIMARY KEY, value TEXT)`, args: [] },
    { sql: `CREATE TABLE IF NOT EXISTS clients (
              id INTEGER PRIMARY KEY AUTOINCREMENT,
              name TEXT NOT NULL,
              address TEXT,
              reference TEXT,
              zone TEXT DEFAULT 'Otra',
              phone TEXT,
              phone_normalized TEXT,
              type TEXT DEFAULT 'Residencial',
              business_type TEXT,
              preferred_balloon TEXT DEFAULT '10kg',
              purchase_frequency TEXT DEFAULT 'irregular',
              notes TEXT,
              debt REAL DEFAULT 0,
              is_vip INTEGER DEFAULT 0,
              created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
              last_whatsapp_at DATETIME,
              wa_opt_in INTEGER DEFAULT 0,
              wa_opt_in_at DATETIME,
              wa_opt_in_source TEXT,
              wa_marketing_opt_out_at DATETIME
            )`, args: [] },
    { sql: `CREATE TABLE IF NOT EXISTS riders (
              id INTEGER PRIMARY KEY AUTOINCREMENT,
              name TEXT NOT NULL,
              phone TEXT,
              zone TEXT,
              active INTEGER DEFAULT 1
            )`, args: [] },
    { sql: `CREATE TABLE IF NOT EXISTS orders (
              id INTEGER PRIMARY KEY AUTOINCREMENT,
              client_id INTEGER,
              rider_id INTEGER,
              status TEXT DEFAULT 'Pendiente',
              payment_method TEXT DEFAULT 'Efectivo',
              total REAL DEFAULT 0,
              notes TEXT,
              created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
              delivered_at DATETIME
            )`, args: [] },
    { sql: `CREATE TABLE IF NOT EXISTS order_items (
              id INTEGER PRIMARY KEY AUTOINCREMENT,
              order_id INTEGER,
              product TEXT,
              description TEXT,
              quantity INTEGER DEFAULT 1,
              unit_price REAL DEFAULT 0,
              subtotal REAL DEFAULT 0
            )`, args: [] },
    { sql: `CREATE TABLE IF NOT EXISTS wa_conversations (
              id INTEGER PRIMARY KEY AUTOINCREMENT,
              client_id INTEGER,
              phone TEXT,
              phone_normalized TEXT NOT NULL,
              contact_name TEXT,
              status TEXT DEFAULT 'open',
              assigned_to TEXT,
              last_message_at DATETIME,
              last_inbound_at DATETIME,
              unread_count INTEGER DEFAULT 0,
              created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
              updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
            )`, args: [] },
    { sql: `CREATE TABLE IF NOT EXISTS wa_messages (
              id INTEGER PRIMARY KEY AUTOINCREMENT,
              conversation_id INTEGER,
              client_id INTEGER,
              phone TEXT,
              phone_normalized TEXT,
              message TEXT,
              body TEXT,
              direction TEXT DEFAULT 'inbound',
              type TEXT DEFAULT 'text',
              wa_message_id TEXT,
              status TEXT DEFAULT 'received',
              error_code TEXT,
              error_message TEXT,
              raw_payload TEXT,
              sent_at DATETIME,
              delivered_at DATETIME,
              read_at DATETIME,
              received_at DATETIME DEFAULT CURRENT_TIMESTAMP,
              created_at DATETIME DEFAULT CURRENT_TIMESTAMP
            )`, args: [] },
  ], 'write');

  const clientColumns = [
    ['phone_normalized', 'TEXT'],
    ['last_whatsapp_at', 'DATETIME'],
    ['wa_opt_in', 'INTEGER DEFAULT 0'],
    ['wa_opt_in_at', 'DATETIME'],
    ['wa_opt_in_source', 'TEXT'],
    ['wa_marketing_opt_out_at', 'DATETIME'],
  ];
  const messageColumns = [
    ['conversation_id', 'INTEGER'],
    ['phone_normalized', 'TEXT'],
    ['body', 'TEXT'],
    ['direction', `TEXT DEFAULT 'inbound'`],
    ['type', `TEXT DEFAULT 'text'`],
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

  for (const [name, definition] of clientColumns) await ensureColumn('clients', name, definition);
  for (const [name, definition] of conversationColumns) await ensureColumn('wa_conversations', name, definition);
  for (const [name, definition] of messageColumns) await ensureColumn('wa_messages', name, definition);

  await db.execute({ sql: 'CREATE UNIQUE INDEX IF NOT EXISTS idx_wa_conversations_phone_normalized ON wa_conversations(phone_normalized)', args: [] });
  await db.execute({ sql: 'CREATE UNIQUE INDEX IF NOT EXISTS idx_wa_messages_wa_message_id ON wa_messages(wa_message_id)', args: [] });
  await db.execute({ sql: 'CREATE INDEX IF NOT EXISTS idx_wa_messages_conversation_created ON wa_messages(conversation_id, created_at)', args: [] });
  await db.execute({ sql: 'CREATE INDEX IF NOT EXISTS idx_clients_phone_normalized ON clients(phone_normalized)', args: [] });

  const defaults = {
    pin: '1234', daily_goal: '80', price_10kg: '38', price_40kg: '120',
    price_water: '12', price_cleaning: '15',
    zones: 'San Borja,Surco,Miraflores,Otra', dark_mode: 'false',
  };
  await Promise.all(
    Object.entries(defaults).map(([key, value]) =>
      db.execute({ sql: 'INSERT OR IGNORE INTO config (key, value) VALUES (?, ?)', args: [key, value] })
    )
  );
}

async function migrateExistingWhatsappRows() {
  const clients = rows(await db.execute({
    sql: `SELECT id, phone, phone_normalized FROM clients WHERE phone IS NOT NULL AND phone != ''`,
    args: [],
  }));
  for (const client of clients) {
    const normalized = normalizePhone(client.phone);
    if (normalized && client.phone_normalized !== normalized) {
      await db.execute({
        sql: 'UPDATE clients SET phone_normalized = ? WHERE id = ?',
        args: [normalized, client.id],
      });
    }
  }

  const legacyMessages = rows(await db.execute({
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

  for (const message of legacyMessages) {
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
    const receivedAt = message.received_at || message.created_at || new Date().toISOString();

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

async function seed() {
  console.log('🌱 Preparando base de datos de prueba...');
  await ensureSchema();
  await migrateExistingWhatsappRows();

  const existingClients = row(await db.execute({ sql: 'SELECT COUNT(*) as total FROM clients', args: [] }));
  if ((existingClients?.total || 0) > 0) {
    console.log('✅ Esquema actualizado. La base ya tiene clientes, no se insertaron datos de prueba ni se borró información.');
    return;
  }

  const r1 = lastId(await db.execute({ sql: 'INSERT INTO riders (name, phone, zone) VALUES (?,?,?)', args: ['Juan Pérez',    '987654321', 'San Borja'] }));
  const r2 = lastId(await db.execute({ sql: 'INSERT INTO riders (name, phone, zone) VALUES (?,?,?)', args: ['Pedro Quispe',  '976543210', 'Surco'] }));
  const r3 = lastId(await db.execute({ sql: 'INSERT INTO riders (name, phone, zone) VALUES (?,?,?)', args: ['Carlos Mamani', '965432109', 'Miraflores'] }));

  const clientData = [
    ['Rosa Flores',         'Av. San Borja Norte 450', 'Frente al parque',             'San Borja',  '987100001', 'Negocio',     'restaurante', '40kg',  'diaria',    'Pide todos los lunes y jueves',        1, 0],
    ['Luis Mendoza',        'Jr. Las Camelias 234',    'Piso 2, timbre azul',          'San Borja',  '987100002', 'Residencial', null,          '10kg',  'semanal',   'Paga siempre con Yape',                0, 0],
    ['Panadería El Sol',    'Av. Primavera 1050',      'Esquina con Caminos del Inca', 'Surco',      '987100003', 'Negocio',     'panadería',   '40kg',  'diaria',    'Necesita entrega antes de las 6am',    1, 150],
    ['María Torres',        'Calle Los Álamos 78',     'Casa con reja verde',          'Surco',      '987100004', 'Residencial', null,          '10kg',  'quincenal', '',                                     0, 0],
    ['Lavandería Limpia Ya','Av. Benavides 3200',      'Al lado del banco BCP',        'Miraflores', '987100005', 'Negocio',     'lavandería',  'Ambos', 'semanal',   'Paga mitad efectivo, mitad Yape',      0, 0],
    ['Mercado Santa Rosa',  'Jr. Schell 450',          'Entrada principal mercado',    'Miraflores', '987100006', 'Negocio',     'mercado',     '40kg',  'diaria',    'Cliente VIP, siempre paga al contado', 1, 0],
    ['Ana Villanueva',      'Calle Las Flores 123',    'Departamento 301',             'San Borja',  '987100007', 'Residencial', null,          '10kg',  'mensual',   'Prefiere llamar antes de entregar',    0, 0],
    ['Restaurante El Sabor','Av. Del Ejército 890',    'Segundo piso',                 'Miraflores', '987100008', 'Negocio',     'restaurante', '40kg',  'diaria',    'Piden de 2 a 3 balones por día',       1, 0],
    ['Jorge Castillo',      'Av. Velasco Astete 567',  'Casa amarilla',                'Surco',      '987100009', 'Residencial', null,          '10kg',  'semanal',   '',                                     0, 30],
    ['Griselda Huanca',     'Calle Independencia 890', 'Frente a la iglesia',          'Otra',       '987100010', 'Residencial', null,          '10kg',  'irregular', 'Vive al fondo del pasaje',             0, 0],
  ];

  const clientIds = [];
  for (const client of clientData) {
    const phoneNormalized = normalizePhone(client[4]) || null;
    const result = await db.execute({
      sql: `INSERT INTO clients
              (name, address, reference, zone, phone, phone_normalized, type, business_type,
               preferred_balloon, purchase_frequency, notes, is_vip, debt)
            VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      args: [
        client[0], client[1], client[2], client[3], client[4], phoneNormalized,
        client[5], client[6], client[7], client[8], client[9], client[10], client[11],
      ],
    });
    clientIds.push(lastId(result));
  }

  const today = new Date();
  async function makeOrderAt(hoursAgo, clientId, riderId, status, payMethod, itemsList, notes = '') {
    const d = new Date(today);
    d.setHours(d.getHours() - hoursAgo);
    const total = itemsList.reduce((sum, item) => sum + item.qty * item.price, 0);
    const result = await db.execute({
      sql: 'INSERT INTO orders (client_id, rider_id, status, payment_method, total, notes, created_at) VALUES (?,?,?,?,?,?,?)',
      args: [clientId, riderId, status, payMethod, total, notes, d.toISOString()],
    });
    const orderId = lastId(result);
    for (const item of itemsList) {
      await db.execute({
        sql: 'INSERT INTO order_items (order_id, product, quantity, unit_price, subtotal) VALUES (?,?,?,?,?)',
        args: [orderId, item.product, item.qty, item.price, item.qty * item.price],
      });
    }
  }

  await makeOrderAt(3,   clientIds[0], r1, 'Entregado', 'Efectivo', [{ product: 'Balón 40kg', qty: 2, price: 120 }], 'Entrega en cocina');
  await makeOrderAt(2,   clientIds[1], r2, 'Entregado', 'Yape',     [{ product: 'Balón 10kg', qty: 1, price: 38 }, { product: 'Agua bidón 20L', qty: 2, price: 12 }]);
  await makeOrderAt(1,   clientIds[2], r1, 'En camino', 'Efectivo', [{ product: 'Balón 40kg', qty: 3, price: 120 }], 'Llamar antes de llegar');
  await makeOrderAt(0.5, clientIds[5], r3, 'Pendiente', 'Yape',     [{ product: 'Balón 40kg', qty: 4, price: 120 }, { product: 'Balón 10kg', qty: 2, price: 38 }]);
  await makeOrderAt(0.1, clientIds[7], r3, 'Pendiente', 'Efectivo', [{ product: 'Balón 40kg', qty: 2, price: 120 }]);

  for (let day = 1; day <= 14; day++) {
    const d = new Date(today);
    d.setDate(d.getDate() - day);
    for (let i = 0; i < 4; i++) {
      const clientId = clientIds[i % clientIds.length];
      const riderId = [r1, r2, r3][i % 3];
      const ts = new Date(d.getTime() + i * 3600000).toISOString();
      const total = (i % 2 === 0 ? 2 : 1) * 120 + (i % 3) * 38;
      const result = await db.execute({
        sql: 'INSERT INTO orders (client_id, rider_id, status, payment_method, total, notes, created_at) VALUES (?,?,?,?,?,?,?)',
        args: [clientId, riderId, 'Entregado', 'Efectivo', total, '', ts],
      });
      const orderId = lastId(result);
      if (i % 2 === 0) {
        await db.execute({ sql: 'INSERT INTO order_items (order_id, product, quantity, unit_price, subtotal) VALUES (?,?,?,?,?)', args: [orderId, 'Balón 40kg', 2, 120, 240] });
      } else {
        await db.execute({ sql: 'INSERT INTO order_items (order_id, product, quantity, unit_price, subtotal) VALUES (?,?,?,?,?)', args: [orderId, 'Balón 10kg', 1, 38, 38] });
      }
    }
  }

  console.log('✅ Datos de prueba cargados correctamente');
  console.log('   - 3 motorizados: Juan, Pedro, Carlos');
  console.log('   - 10 clientes en San Borja, Surco, Miraflores');
  console.log('   - 5 pedidos del día en diferentes estados');
  console.log('   - Historial de 2 semanas para reportes');
  console.log('\n📌 PIN de acceso: 1234');
}

seed().catch(err => { console.error('❌ Error:', err); process.exit(1); });
