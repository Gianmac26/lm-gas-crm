require('dotenv').config();
const { createClient } = require('@libsql/client');

const db = createClient({
  url:       process.env.TURSO_DATABASE_URL || 'file:./database/lm_gas.db',
  authToken: process.env.TURSO_AUTH_TOKEN,
});

async function seed() {
  console.log('🌱 Cargando datos de prueba...');

  // Crear tablas
  await db.batch([
    { sql: `CREATE TABLE IF NOT EXISTS config (key TEXT PRIMARY KEY, value TEXT)`, args: [] },
    { sql: `CREATE TABLE IF NOT EXISTS clients (
              id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL, address TEXT, reference TEXT,
              zone TEXT DEFAULT 'Otra', phone TEXT, type TEXT DEFAULT 'Residencial', business_type TEXT,
              preferred_balloon TEXT DEFAULT '10kg', purchase_frequency TEXT DEFAULT 'irregular',
              notes TEXT, debt REAL DEFAULT 0, is_vip INTEGER DEFAULT 0, created_at DATETIME DEFAULT CURRENT_TIMESTAMP
            )`, args: [] },
    { sql: `CREATE TABLE IF NOT EXISTS riders (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL, phone TEXT, zone TEXT, active INTEGER DEFAULT 1)`, args: [] },
    { sql: `CREATE TABLE IF NOT EXISTS orders (
              id INTEGER PRIMARY KEY AUTOINCREMENT, client_id INTEGER, rider_id INTEGER,
              status TEXT DEFAULT 'Pendiente', payment_method TEXT DEFAULT 'Efectivo',
              total REAL DEFAULT 0, notes TEXT, created_at DATETIME DEFAULT CURRENT_TIMESTAMP, delivered_at DATETIME
            )`, args: [] },
    { sql: `CREATE TABLE IF NOT EXISTS order_items (
              id INTEGER PRIMARY KEY AUTOINCREMENT, order_id INTEGER, product TEXT, description TEXT,
              quantity INTEGER DEFAULT 1, unit_price REAL DEFAULT 0, subtotal REAL DEFAULT 0
            )`, args: [] },
    { sql: `CREATE TABLE IF NOT EXISTS wa_messages (id INTEGER PRIMARY KEY AUTOINCREMENT, client_id INTEGER, phone TEXT, message TEXT, received_at DATETIME DEFAULT CURRENT_TIMESTAMP)`, args: [] },
  ], 'write');

  // Limpiar
  await db.batch([
    { sql: 'DELETE FROM wa_messages', args: [] },
    { sql: 'DELETE FROM order_items', args: [] },
    { sql: 'DELETE FROM orders',      args: [] },
    { sql: 'DELETE FROM clients',     args: [] },
    { sql: 'DELETE FROM riders',      args: [] },
  ], 'write');

  // Motorizados
  const r1 = Number((await db.execute({ sql: 'INSERT INTO riders (name, phone, zone) VALUES (?,?,?)', args: ['Juan Pérez',    '987654321', 'San Borja']   })).lastInsertRowid);
  const r2 = Number((await db.execute({ sql: 'INSERT INTO riders (name, phone, zone) VALUES (?,?,?)', args: ['Pedro Quispe',  '976543210', 'Surco']        })).lastInsertRowid);
  const r3 = Number((await db.execute({ sql: 'INSERT INTO riders (name, phone, zone) VALUES (?,?,?)', args: ['Carlos Mamani', '965432109', 'Miraflores']   })).lastInsertRowid);

  // Clientes
  const clientData = [
    ['Rosa Flores',        'Av. San Borja Norte 450', 'Frente al parque',             'San Borja',  '987100001', 'Negocio',      'restaurante', '40kg',  'diaria',    'Pide todos los lunes y jueves',          1, 0],
    ['Luis Mendoza',       'Jr. Las Camelias 234',    'Piso 2, timbre azul',          'San Borja',  '987100002', 'Residencial',  null,          '10kg',  'semanal',   'Paga siempre con Yape',                  0, 0],
    ['Panadería El Sol',   'Av. Primavera 1050',      'Esquina con Caminos del Inca', 'Surco',      '987100003', 'Negocio',      'panadería',   '40kg',  'diaria',    'Necesita entrega antes de las 6am',      1, 150],
    ['María Torres',       'Calle Los Álamos 78',     'Casa con reja verde',          'Surco',      '987100004', 'Residencial',  null,          '10kg',  'quincenal', '',                                       0, 0],
    ['Lavandería Limpia Ya','Av. Benavides 3200',     'Al lado del banco BCP',        'Miraflores', '987100005', 'Negocio',      'lavandería',  'Ambos', 'semanal',   'Paga mitad efectivo, mitad Yape',        0, 0],
    ['Mercado Santa Rosa', 'Jr. Schell 450',          'Entrada principal mercado',    'Miraflores', '987100006', 'Negocio',      'mercado',     '40kg',  'diaria',    'Cliente VIP, siempre paga al contado',   1, 0],
    ['Ana Villanueva',     'Calle Las Flores 123',    'Departamento 301',             'San Borja',  '987100007', 'Residencial',  null,          '10kg',  'mensual',   'Prefiere llamar antes de entregar',      0, 0],
    ['Restaurante El Sabor','Av. Del Ejército 890',   'Segundo piso',                 'Miraflores', '987100008', 'Negocio',      'restaurante', '40kg',  'diaria',    'Piden de 2 a 3 balones por día',         1, 0],
    ['Jorge Castillo',     'Av. Velasco Astete 567',  'Casa amarilla',                'Surco',      '987100009', 'Residencial',  null,          '10kg',  'semanal',   '',                                       0, 30],
    ['Griselda Huanca',    'Calle Independencia 890', 'Frente a la iglesia',          'Otra',       '987100010', 'Residencial',  null,          '10kg',  'irregular', 'Vive al fondo del pasaje',               0, 0],
  ];
  const clientIds = [];
  for (const c of clientData) {
    const r = await db.execute({
      sql:  `INSERT INTO clients (name, address, reference, zone, phone, type, business_type, preferred_balloon, purchase_frequency, notes, is_vip, debt) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
      args: c,
    });
    clientIds.push(Number(r.lastInsertRowid));
  }

  // Helper para crear pedidos
  const today = new Date();
  async function makeOrderAt(hoursAgo, clientId, riderId, status, payMethod, itemsList, notes = '') {
    const d = new Date(today);
    d.setHours(d.getHours() - hoursAgo);
    const total = itemsList.reduce((s, i) => s + i.qty * i.price, 0);
    const res = await db.execute({
      sql:  `INSERT INTO orders (client_id, rider_id, status, payment_method, total, notes, created_at) VALUES (?,?,?,?,?,?,?)`,
      args: [clientId, riderId, status, payMethod, total, notes, d.toISOString()],
    });
    const orderId = Number(res.lastInsertRowid);
    for (const i of itemsList) {
      await db.execute({ sql: `INSERT INTO order_items (order_id, product, quantity, unit_price, subtotal) VALUES (?,?,?,?,?)`, args: [orderId, i.product, i.qty, i.price, i.qty * i.price] });
    }
    return orderId;
  }

  // 5 pedidos del día
  await makeOrderAt(3,   clientIds[0], r1, 'Entregado',  'Efectivo', [{ product: 'Balón 40kg',   qty: 2, price: 120 }], 'Entrega en cocina');
  await makeOrderAt(2,   clientIds[1], r2, 'Entregado',  'Yape',     [{ product: 'Balón 10kg',   qty: 1, price: 38  }, { product: 'Agua bidón 20L', qty: 2, price: 12 }]);
  await makeOrderAt(1,   clientIds[2], r1, 'En camino',  'Efectivo', [{ product: 'Balón 40kg',   qty: 3, price: 120 }], 'Llamar antes de llegar');
  await makeOrderAt(0.5, clientIds[5], r3, 'Pendiente',  'Yape',     [{ product: 'Balón 40kg',   qty: 4, price: 120 }, { product: 'Balón 10kg', qty: 2, price: 38 }]);
  await makeOrderAt(0.1, clientIds[7], r3, 'Pendiente',  'Efectivo', [{ product: 'Balón 40kg',   qty: 2, price: 120 }]);

  // Historial 2 semanas
  for (let day = 1; day <= 14; day++) {
    const d = new Date(today);
    d.setDate(d.getDate() - day);
    for (let i = 0; i < 4; i++) {
      const ci    = clientIds[i % clientIds.length];
      const ri    = [r1, r2, r3][i % 3];
      const total = (i % 2 === 0 ? 2 : 1) * 120 + (i % 3) * 38;
      const ts    = new Date(d.getTime() + i * 3600000).toISOString();
      const res   = await db.execute({ sql: `INSERT INTO orders (client_id, rider_id, status, payment_method, total, notes, created_at) VALUES (?,?,?,?,?,?,?)`, args: [ci, ri, 'Entregado', 'Efectivo', total, '', ts] });
      const oid   = Number(res.lastInsertRowid);
      if (i % 2 === 0) await db.execute({ sql: `INSERT INTO order_items (order_id, product, quantity, unit_price, subtotal) VALUES (?,?,?,?,?)`, args: [oid, 'Balón 40kg', 2, 120, 240] });
      else             await db.execute({ sql: `INSERT INTO order_items (order_id, product, quantity, unit_price, subtotal) VALUES (?,?,?,?,?)`, args: [oid, 'Balón 10kg', 1, 38,  38]  });
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
