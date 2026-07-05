# Importar lista externa (CSV) en Campañas — Plan de Implementación

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Agregar una fuente de destinatarios nueva al wizard de Campañas — importar un CSV de contactos externos a una tabla separada (`campaign_contacts`), sin mezclarlos con la tabla `clients`, y permitir enviarles una campaña igual que a cualquier segmento existente.

**Architecture:** Tabla nueva `campaign_contacts` (aislada de `clients`, para no contaminar reportes de negocio). El endpoint de import valida el archivo completo antes de procesar filas, y cada fila se valida y deduplica (contra `clients` y contra `campaign_contacts`) antes de insertar. El envío (`POST /api/campaigns/send`) y el historial (`campaign_logs`) se extienden para soportar 2 fuentes de destinatarios sin mezclar sus espacios de IDs. El frontend lee el CSV en el navegador (`File.text()`) y lo manda como texto plano — sin dependencias nuevas.

**Tech Stack:** Node.js + Express + libSQL (`lib/db.js`), React 18 + Vite + Tailwind + lucide-react, pruebas con `node:test` contra un servidor real y una base SQLite temporal (mismo patrón que `test/orders.debt.test.js` y `test/conversations.test.js`).

## Global Constraints

- **Corrección de spec importante:** `campaign_contacts` y las columnas nuevas de `campaign_logs` se agregan al `initDb()` de `server.js` (líneas ~20-471), **no** a `seed.js`. `seed.js` es un script manual (`npm run seed`) con su propio esquema duplicado e independiente; `server.js`'s `initDb()` es lo único que corre en la app real y en los tests automatizados (`require('../server')`).
- **Bug preexistente a corregir en la misma tarea:** hoy `campaign_logs` existe en `seed.js` pero **nunca se crea en `server.js`** — en una base de datos fresca (tests, o un despliegue sin `npm run seed`), `/api/campaigns/send` y `/api/campaigns/history` fallarían con "no such table: campaign_logs". La Task 1 agrega el `CREATE TABLE IF NOT EXISTS campaign_logs` que falta, además de `campaign_contacts`.
- No se necesita ningún procedimiento especial de aislamiento de git — ya no hay un agente de Gemini trabajando en paralelo en este código.
- Ya no se toca `client/src/components/Campaigns.jsx`'s `client_id` en `campaign_logs` para contactos importados — usar la columna nueva `campaign_contact_id`, dejando `client_id` en `NULL` para esa fuente (y viceversa). Nunca se mezclan los dos espacios de IDs.

---

## Task 1: Backend — esquema (campaign_contacts + fix de campaign_logs)

**Files:**
- Modify: `server.js` (dentro de `initDb()`, líneas ~449-453)
- Test: `test/campaigns.test.js` (nuevo)

**Interfaces:**
- Produces: tabla `campaign_contacts` (`id, phone, phone_normalized UNIQUE, nombre, zona, import_batch, created_at`); tabla `campaign_logs` con columnas nuevas `contact_source` (default `'clients'`) y `campaign_contact_id` (nullable, referencia a `campaign_contacts.id`).

- [ ] **Step 1: Escribir el test (debe fallar)**

Crear `test/campaigns.test.js`:

```js
/**
 * Pruebas del módulo de Campañas: esquema, importar CSV, envío con 2 fuentes.
 * Corre contra una base SQLite temporal (no toca producción).
 *   Ejecutar: npm test
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const TMP_DB = path.join(os.tmpdir(), `lmtest_campaigns_${Date.now()}.db`);
process.env.TURSO_DATABASE_URL = 'file:' + TMP_DB;
delete process.env.TURSO_AUTH_TOKEN;
process.env.WHATSAPP_ACCESS_TOKEN = 'test-token';
process.env.WHATSAPP_PHONE_NUMBER_ID = '000000000';

const app = require('../server');
const { db, row, rows } = require('../lib/db');

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

async function createClient({ name, phone }) {
  const { data } = await api('POST', '/api/clients', {
    name, address: '', reference: '', zone: 'Otra', phone,
    type: 'Residencial', business_type: '', preferred_balloon: '10kg',
    purchase_frequency: 'irregular', notes: '', is_vip: false,
  });
  return data.id;
}

test('initDb crea las tablas campaign_contacts y campaign_logs con las columnas nuevas', async () => {
  const contactsCols = rows(await db.execute({ sql: 'PRAGMA table_info(campaign_contacts)', args: [] })).map(c => c.name);
  assert.ok(contactsCols.includes('phone_normalized'), 'debe tener phone_normalized');
  assert.ok(contactsCols.includes('import_batch'), 'debe tener import_batch');
  assert.ok(contactsCols.includes('nombre'), 'debe tener nombre');
  assert.ok(contactsCols.includes('zona'), 'debe tener zona');

  const logsCols = rows(await db.execute({ sql: 'PRAGMA table_info(campaign_logs)', args: [] })).map(c => c.name);
  assert.ok(logsCols.includes('contact_source'), 'debe tener contact_source');
  assert.ok(logsCols.includes('campaign_contact_id'), 'debe tener campaign_contact_id');
  assert.ok(logsCols.includes('client_id'), 'debe conservar client_id');
});
```

- [ ] **Step 2: Correr el test para verificar que falla**

Run: `npm test`
Expected: FAIL — `PRAGMA table_info(campaign_contacts)` devuelve un array vacío (la tabla no existe todavía), así que el primer `assert.ok` falla.

- [ ] **Step 3: Agregar las tablas al `initDb()` de `server.js`**

Busca este bloque exacto (el cierre del loop de `ensureColumn` de `order_items`, justo antes del comentario de `price_45kg`):

```js
  ]) {
    await ensureColumn('order_items', col, def);
  }

  // ── price_45kg in config (legacy price_40kg was the 45 kg price) ──────────
```

Reemplázalo por:

```js
  ]) {
    await ensureColumn('order_items', col, def);
  }

  // ── Campañas masivas de WhatsApp ────────────────────────────────────────────
  await db.execute({
    sql: `CREATE TABLE IF NOT EXISTS campaign_contacts (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            phone TEXT NOT NULL,
            phone_normalized TEXT NOT NULL UNIQUE,
            nombre TEXT NOT NULL,
            zona TEXT,
            import_batch TEXT NOT NULL,
            created_at DATETIME DEFAULT CURRENT_TIMESTAMP
          )`,
    args: [],
  });
  await db.execute({
    sql: `CREATE TABLE IF NOT EXISTS campaign_logs (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            campaign_id TEXT NOT NULL,
            client_id INTEGER REFERENCES clients(id),
            telefono TEXT NOT NULL,
            template_name TEXT NOT NULL,
            status TEXT NOT NULL DEFAULT 'pending',
            error_message TEXT,
            sent_at DATETIME DEFAULT CURRENT_TIMESTAMP
          )`,
    args: [],
  });
  await ensureColumn('campaign_logs', 'contact_source', "TEXT NOT NULL DEFAULT 'clients'");
  await ensureColumn('campaign_logs', 'campaign_contact_id', 'INTEGER REFERENCES campaign_contacts(id)');

  // ── price_45kg in config (legacy price_40kg was the 45 kg price) ──────────
```

- [ ] **Step 4: Correr el test para verificar que pasa**

Run: `npm test`
Expected: PASS — el test de esquema pasa, y los tests de `test/orders.debt.test.js` y `test/conversations.test.js` siguen pasando.

- [ ] **Step 5: Commit**

```bash
git add server.js test/campaigns.test.js
git commit -m "feat(campañas): agrega tabla campaign_contacts y corrige campaign_logs faltante en initDb()"
```

---

## Task 2: Backend — `POST /api/campaigns/import-contacts`

**Files:**
- Modify: `server.js` (nuevo helper `parseCsv` + nuevo endpoint, insertado entre `GET /api/campaigns/eligible-clients` y `POST /api/campaigns/send`)
- Test: `test/campaigns.test.js`

**Interfaces:**
- Consumes: `campaign_contacts` (Task 1), `normalizePhone` (ya importado de `lib/db.js`), `isValidWhatsappPhone` (ya definido en `server.js`), `todayStr` (ya importado de `lib/db.js`).
- Produces: `POST /api/campaigns/import-contacts` — body `{ csv: string }` → 200 con `{ import_batch, contacts: [{id, nombre, telefono, zona, tipo: null, dias_sin_pedir: null}], summary: {total_filas, importados, ya_cliente, ya_importado, invalidas} }`; 400 si el archivo está vacío, le faltan columnas requeridas, o no tiene filas de datos.

- [ ] **Step 1: Agregar los tests (deben fallar)**

Al final de `test/campaigns.test.js`, agrega:

```js

test('POST /api/campaigns/import-contacts importa válidas y cuenta duplicados/inválidas', async () => {
  await createClient({ name: 'Cliente Existente', phone: '51911111111' });

  const csv = [
    'telefono,nombre_o_referencia,zona',
    '51922222222,Prospecto Uno,San Borja',
    '51911111111,Ya Es Cliente,Surco',
    'no-es-telefono,Invalido,Otra',
    '51922222222,Prospecto Uno Repetido,San Borja',
  ].join('\n');

  const res = await api('POST', '/api/campaigns/import-contacts', { csv });
  assert.equal(res.status, 200);
  assert.equal(res.data.summary.total_filas, 4);
  assert.equal(res.data.summary.importados, 1);
  assert.equal(res.data.summary.ya_cliente, 1);
  assert.equal(res.data.summary.ya_importado, 1);
  assert.equal(res.data.summary.invalidas, 1);
  assert.equal(res.data.contacts.length, 1);
  assert.equal(res.data.contacts[0].telefono, '51922222222');
  assert.equal(res.data.contacts[0].zona, 'San Borja');
  assert.equal(res.data.contacts[0].dias_sin_pedir, null);
  assert.match(res.data.import_batch, /^IMPORTADO_\d{4}-\d{2}-\d{2}$/);
});

test('POST /api/campaigns/import-contacts reimportar el mismo CSV no duplica', async () => {
  const csv = ['telefono,nombre_o_referencia', '51933333333,Prospecto Dos'].join('\n');

  const first = await api('POST', '/api/campaigns/import-contacts', { csv });
  assert.equal(first.data.summary.importados, 1);

  const second = await api('POST', '/api/campaigns/import-contacts', { csv });
  assert.equal(second.data.summary.importados, 0);
  assert.equal(second.data.summary.ya_importado, 1);
});

test('POST /api/campaigns/import-contacts rechaza archivo vacío', async () => {
  const res = await api('POST', '/api/campaigns/import-contacts', { csv: '' });
  assert.equal(res.status, 400);
});

test('POST /api/campaigns/import-contacts rechaza headers faltantes', async () => {
  const csv = ['telefono,otra_columna', '51944444444,algo'].join('\n');
  const res = await api('POST', '/api/campaigns/import-contacts', { csv });
  assert.equal(res.status, 400);
  assert.match(res.data.error, /nombre_o_referencia/);
});

test('POST /api/campaigns/import-contacts rechaza archivo sin filas de datos', async () => {
  const res = await api('POST', '/api/campaigns/import-contacts', { csv: 'telefono,nombre_o_referencia' });
  assert.equal(res.status, 400);
});
```

- [ ] **Step 2: Correr los tests para verificar que fallan**

Run: `npm test`
Expected: FAIL con status 404 en los 5 (la ruta no existe todavía).

- [ ] **Step 3: Agregar el helper `parseCsv` y el endpoint**

En `server.js`, busca este bloque exacto:

```js
    const clients = rows(await db.execute({ sql, args }));
    res.json(clients);
  } catch (err) {
    return sendInternalError(res, 'Error obteniendo clientes elegibles:', err);
  }
});

app.post('/api/campaigns/send', async (req, res) => {
```

Reemplázalo por:

```js
    const clients = rows(await db.execute({ sql, args }));
    res.json(clients);
  } catch (err) {
    return sendInternalError(res, 'Error obteniendo clientes elegibles:', err);
  }
});

function parseCsv(text) {
  const lines = text.split(/\r?\n/).map(l => l.trim()).filter(l => l.length > 0);
  if (lines.length === 0) return { headers: [], rows: [] };
  const headers = lines[0].split(',').map(h => h.trim().toLowerCase());
  const dataRows = lines.slice(1).map(line => {
    const cells = line.split(',').map(c => c.trim());
    const dataRow = {};
    headers.forEach((h, i) => { dataRow[h] = cells[i] !== undefined ? cells[i] : ''; });
    return dataRow;
  });
  return { headers, rows: dataRows };
}

app.post('/api/campaigns/import-contacts', async (req, res) => {
  try {
    const csvText = typeof req.body?.csv === 'string' ? req.body.csv.trim() : '';
    if (!csvText) {
      return res.status(400).json({ error: 'El archivo está vacío.' });
    }

    const { headers, rows: dataRows } = parseCsv(csvText);
    if (!headers.includes('telefono') || !headers.includes('nombre_o_referencia')) {
      return res.status(400).json({
        error: `El CSV debe tener las columnas 'telefono' y 'nombre_o_referencia'. Encontradas: ${headers.join(', ')}.`,
      });
    }
    if (dataRows.length === 0) {
      return res.status(400).json({ error: 'El archivo no tiene filas de datos, solo encabezado.' });
    }

    const importBatch = `IMPORTADO_${todayStr()}`;
    const summary = { total_filas: dataRows.length, importados: 0, ya_cliente: 0, ya_importado: 0, invalidas: 0 };
    const imported = [];

    for (const dataRow of dataRows) {
      const phoneNormalized = normalizePhone(dataRow.telefono);
      const nombre = (dataRow.nombre_o_referencia || '').trim();
      const zona = (dataRow.zona || '').trim() || null;

      if (!isValidWhatsappPhone(phoneNormalized) || !nombre) {
        summary.invalidas++;
        continue;
      }

      const existingClient = row(await db.execute({
        sql: 'SELECT id FROM clients WHERE phone_normalized = ? LIMIT 1',
        args: [phoneNormalized],
      }));
      if (existingClient) {
        summary.ya_cliente++;
        continue;
      }

      const existingContact = row(await db.execute({
        sql: 'SELECT id FROM campaign_contacts WHERE phone_normalized = ? LIMIT 1',
        args: [phoneNormalized],
      }));
      if (existingContact) {
        summary.ya_importado++;
        continue;
      }

      const insertResult = await db.execute({
        sql: `INSERT INTO campaign_contacts (phone, phone_normalized, nombre, zona, import_batch)
              VALUES (?, ?, ?, ?, ?)`,
        args: [dataRow.telefono, phoneNormalized, nombre, zona, importBatch],
      });
      summary.importados++;
      imported.push({
        id: lastId(insertResult),
        nombre,
        telefono: phoneNormalized,
        zona,
        tipo: null,
        dias_sin_pedir: null,
      });
    }

    res.json({ import_batch: importBatch, contacts: imported, summary });
  } catch (err) {
    return sendInternalError(res, 'Error importando contactos de campaña:', err);
  }
});

app.post('/api/campaigns/send', async (req, res) => {
```

- [ ] **Step 4: Correr los tests para verificar que pasan**

Run: `npm test`
Expected: PASS — los 5 tests nuevos pasan, y los tests previos (Task 1, `orders.debt.test.js`, `conversations.test.js`) siguen pasando.

- [ ] **Step 5: Commit**

```bash
git add server.js test/campaigns.test.js
git commit -m "feat(campañas): agrega endpoint de importar contactos vía CSV (POST /api/campaigns/import-contacts)"
```

---

## Task 3: Backend — `POST /api/campaigns/send` con 2 fuentes

**Files:**
- Modify: `server.js` (endpoint `POST /api/campaigns/send` completo)
- Test: `test/campaigns.test.js`

**Interfaces:**
- Consumes: `campaign_contacts` (Task 1), `contacts` devueltos por `import-contacts` (Task 2).
- Produces: `POST /api/campaigns/send` acepta un campo nuevo opcional `source: 'clients' | 'campaign_contacts'` (default `'clients'`). Cuando `source === 'campaign_contacts'`, busca destinatarios en `campaign_contacts` en vez de `clients`. `campaign_logs` guarda `contact_source` y, según corresponda, `client_id` o `campaign_contact_id` (el otro queda `NULL`).

- [ ] **Step 1: Agregar los tests (deben fallar)**

Al final de `test/campaigns.test.js`, agrega:

```js

test('POST /api/campaigns/send con source=campaign_contacts registra campaign_contact_id, no client_id', async () => {
  // Teléfono de 8 dígitos: pasa la validación de import (isValidWhatsappPhone,
  // 8-15 dígitos) pero falla el regex estricto de envío (/^519\d{8}$/),
  // así que el endpoint de send falla en la rama "teléfono inválido" sin
  // necesidad de una llamada real a la API de Meta.
  const csv = ['telefono,nombre_o_referencia', '12345678,Prospecto Telefono Raro'].join('\n');
  const importRes = await api('POST', '/api/campaigns/import-contacts', { csv });
  const contactId = importRes.data.contacts[0].id;
  assert.equal(importRes.data.contacts[0].telefono, '12345678');

  const sendRes = await api('POST', '/api/campaigns/send', {
    template_name: 'plantilla_test',
    template_language: 'es',
    client_ids: [contactId],
    source: 'campaign_contacts',
  });
  assert.equal(sendRes.status, 200);
  assert.equal(sendRes.data.failed, 1);
  assert.equal(sendRes.data.results[0].error, 'Número de teléfono inválido o ausente.');

  const logRow = row(await db.execute({
    sql: 'SELECT client_id, campaign_contact_id, contact_source FROM campaign_logs WHERE campaign_id = ? LIMIT 1',
    args: [sendRes.data.campaign_id],
  }));
  assert.equal(logRow.client_id, null);
  assert.equal(logRow.campaign_contact_id, contactId);
  assert.equal(logRow.contact_source, 'campaign_contacts');
});

test('POST /api/campaigns/send con source=clients (default) registra client_id, no campaign_contact_id', async () => {
  const clientId = await createClient({ name: 'Cliente Telefono Raro', phone: '12345678' });

  const sendRes = await api('POST', '/api/campaigns/send', {
    template_name: 'plantilla_test',
    template_language: 'es',
    client_ids: [clientId],
  });
  assert.equal(sendRes.status, 200);
  assert.equal(sendRes.data.failed, 1);

  const logRow = row(await db.execute({
    sql: 'SELECT client_id, campaign_contact_id, contact_source FROM campaign_logs WHERE campaign_id = ? LIMIT 1',
    args: [sendRes.data.campaign_id],
  }));
  assert.equal(logRow.client_id, clientId);
  assert.equal(logRow.campaign_contact_id, null);
  assert.equal(logRow.contact_source, 'clients');
});
```

- [ ] **Step 2: Correr los tests para verificar que fallan**

Run: `npm test`
Expected: FAIL — `logRow.campaign_contact_id` es `undefined`/`null` incorrectamente y `contact_source` no existe en la fila insertada con el código actual (que no manda esas columnas).

- [ ] **Step 3: Reemplazar el endpoint completo**

En `server.js`, busca este bloque exacto (el endpoint completo de `POST /api/campaigns/send`):

```js
app.post('/api/campaigns/send', async (req, res) => {
  const accessToken = process.env.WHATSAPP_ACCESS_TOKEN;
  const phoneNumberId = process.env.WHATSAPP_PHONE_NUMBER_ID;

  if (!accessToken || !phoneNumberId) {
    return res.status(500).json({ error: 'Configuración de WhatsApp incompleta.' });
  }

  const { template_name, template_language, client_ids, variable_mapping } = req.body;

  if (!template_name || !template_language || !Array.isArray(client_ids) || !client_ids.length) {
    return res.status(400).json({ error: 'Faltan parámetros requeridos: template_name, template_language, client_ids.' });
  }

  const campaign_id = `${Date.now()}_${Math.random().toString(36).substring(2, 9)}`;
  const results = [];
  let sent = 0;
  let failed = 0;

  const clientData = rows(await db.execute({
    sql: `
      WITH ClientLastOrder AS (
        SELECT client_id, MAX(created_at) as last_order_date FROM orders GROUP BY client_id
      )
      SELECT
        c.id,
        c.name as nombre,
        c.phone_normalized as telefono,
        COALESCE(ROUND(julianday('now') - julianday(clo.last_order_date)), NULL) as dias_sin_pedir
      FROM clients c
      LEFT JOIN ClientLastOrder clo ON c.id = clo.client_id
      WHERE c.id IN (${client_ids.map(() => '?').join(',')})`,
    args: client_ids,
  }));

  const clientMap = new Map(clientData.map(c => [c.id, c]));

  for (const clientId of client_ids) {
    const client = clientMap.get(clientId);
    if (!client || !client.telefono || !/^519\d{8}$/.test(client.telefono)) {
      failed++;
      results.push({ client_id: clientId, nombre: client?.nombre, status: 'failed', error: 'Número de teléfono inválido o ausente.' });
      await db.execute({
        sql: `INSERT INTO campaign_logs (campaign_id, client_id, telefono, template_name, status, error_message)
              VALUES (?, ?, ?, ?, 'failed', ?)`,
        args: [campaign_id, clientId, client?.telefono || 'N/A', template_name, 'Número de teléfono inválido o ausente.'],
      });
      continue;
    }

    const components = [];
    if (variable_mapping && Object.keys(variable_mapping).length > 0) {
        const bodyParams = Object.entries(variable_mapping)
            .filter(([key, value]) => !isNaN(parseInt(key))) // filter only body variables
            .map(([key, value]) => {
                let text = value;
                if (client[value]) {
                    text = client[value];
                }
                return { type: 'text', text: String(text) };
            });
        if(bodyParams.length > 0){
             components.push({
                type: 'body',
                parameters: bodyParams
            });
        }
    }

    const payload = {
      messaging_product: 'whatsapp',
      to: client.telefono,
      type: 'template',
      template: {
        name: template_name,
        language: { code: template_language },
        components: components,
      },
    };

    let status = 'pending', error_message = null;
    try {
      const response = await fetch(`https://graph.facebook.com/v21.0/${phoneNumberId}/messages`, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${accessToken}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(payload),
      });

      if (response.ok) {
        status = 'sent';
        sent++;
      } else {
        const errData = await response.json();
        status = 'failed';
        error_message = errData.error?.message || 'Error desconocido de la API de Meta.';
        failed++;
      }
    } catch (err) {
      status = 'failed';
      error_message = err.message;
      failed++;
    }

    results.push({ client_id: clientId, nombre: client.nombre, status, error: error_message });
    await db.execute({
      sql: `INSERT INTO campaign_logs (campaign_id, client_id, telefono, template_name, status, error_message)
            VALUES (?, ?, ?, ?, ?, ?)`,
      args: [campaign_id, clientId, client.telefono, template_name, status, error_message],
    });

    // Espera de 200ms
    await new Promise(resolve => setTimeout(resolve, 200));
  }

  res.status(200).json({
    campaign_id,
    total: client_ids.length,
    sent,
    failed,
    results,
  });
});
```

Reemplázalo por:

```js
app.post('/api/campaigns/send', async (req, res) => {
  const accessToken = process.env.WHATSAPP_ACCESS_TOKEN;
  const phoneNumberId = process.env.WHATSAPP_PHONE_NUMBER_ID;

  if (!accessToken || !phoneNumberId) {
    return res.status(500).json({ error: 'Configuración de WhatsApp incompleta.' });
  }

  const { template_name, template_language, client_ids, variable_mapping } = req.body;
  const source = req.body.source === 'campaign_contacts' ? 'campaign_contacts' : 'clients';

  if (!template_name || !template_language || !Array.isArray(client_ids) || !client_ids.length) {
    return res.status(400).json({ error: 'Faltan parámetros requeridos: template_name, template_language, client_ids.' });
  }

  const campaign_id = `${Date.now()}_${Math.random().toString(36).substring(2, 9)}`;
  const results = [];
  let sent = 0;
  let failed = 0;

  const clientData = rows(await db.execute({
    sql: source === 'campaign_contacts'
      ? `SELECT id, nombre, phone_normalized as telefono, NULL as dias_sin_pedir
         FROM campaign_contacts
         WHERE id IN (${client_ids.map(() => '?').join(',')})`
      : `
        WITH ClientLastOrder AS (
          SELECT client_id, MAX(created_at) as last_order_date FROM orders GROUP BY client_id
        )
        SELECT
          c.id,
          c.name as nombre,
          c.phone_normalized as telefono,
          COALESCE(ROUND(julianday('now') - julianday(clo.last_order_date)), NULL) as dias_sin_pedir
        FROM clients c
        LEFT JOIN ClientLastOrder clo ON c.id = clo.client_id
        WHERE c.id IN (${client_ids.map(() => '?').join(',')})`,
    args: client_ids,
  }));

  const clientMap = new Map(clientData.map(c => [c.id, c]));

  for (const clientId of client_ids) {
    const client = clientMap.get(clientId);
    if (!client || !client.telefono || !/^519\d{8}$/.test(client.telefono)) {
      failed++;
      results.push({ client_id: clientId, nombre: client?.nombre, status: 'failed', error: 'Número de teléfono inválido o ausente.' });
      await db.execute({
        sql: `INSERT INTO campaign_logs (campaign_id, client_id, campaign_contact_id, contact_source, telefono, template_name, status, error_message)
              VALUES (?, ?, ?, ?, ?, ?, 'failed', ?)`,
        args: [
          campaign_id,
          source === 'clients' ? clientId : null,
          source === 'campaign_contacts' ? clientId : null,
          source,
          client?.telefono || 'N/A',
          template_name,
          'Número de teléfono inválido o ausente.',
        ],
      });
      continue;
    }

    const components = [];
    if (variable_mapping && Object.keys(variable_mapping).length > 0) {
        const bodyParams = Object.entries(variable_mapping)
            .filter(([key, value]) => !isNaN(parseInt(key))) // filter only body variables
            .map(([key, value]) => {
                let text = value;
                if (client[value]) {
                    text = client[value];
                }
                return { type: 'text', text: String(text) };
            });
        if(bodyParams.length > 0){
             components.push({
                type: 'body',
                parameters: bodyParams
            });
        }
    }

    const payload = {
      messaging_product: 'whatsapp',
      to: client.telefono,
      type: 'template',
      template: {
        name: template_name,
        language: { code: template_language },
        components: components,
      },
    };

    let status = 'pending', error_message = null;
    try {
      const response = await fetch(`https://graph.facebook.com/v21.0/${phoneNumberId}/messages`, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${accessToken}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(payload),
      });

      if (response.ok) {
        status = 'sent';
        sent++;
      } else {
        const errData = await response.json();
        status = 'failed';
        error_message = errData.error?.message || 'Error desconocido de la API de Meta.';
        failed++;
      }
    } catch (err) {
      status = 'failed';
      error_message = err.message;
      failed++;
    }

    results.push({ client_id: clientId, nombre: client.nombre, status, error: error_message });
    await db.execute({
      sql: `INSERT INTO campaign_logs (campaign_id, client_id, campaign_contact_id, contact_source, telefono, template_name, status, error_message)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      args: [
        campaign_id,
        source === 'clients' ? clientId : null,
        source === 'campaign_contacts' ? clientId : null,
        source,
        client.telefono,
        template_name,
        status,
        error_message,
      ],
    });

    // Espera de 200ms
    await new Promise(resolve => setTimeout(resolve, 200));
  }

  res.status(200).json({
    campaign_id,
    total: client_ids.length,
    sent,
    failed,
    results,
  });
});
```

- [ ] **Step 4: Correr los tests para verificar que pasan**

Run: `npm test`
Expected: PASS — todos los tests de `test/campaigns.test.js`, `test/conversations.test.js` y `test/orders.debt.test.js` pasan.

- [ ] **Step 5: Commit**

```bash
git add server.js test/campaigns.test.js
git commit -m "feat(campañas): POST /api/campaigns/send soporta 2 fuentes (clients y campaign_contacts)"
```

---

## Task 4: Frontend — fix de `getPreview()` (valores vacíos/falsy)

**Files:**
- Modify: `client/src/components/Campaigns.jsx`

**Interfaces:**
- Produces: `getPreview()` distingue explícitamente "campo de cliente conocido" (`CLIENT_DATA_FIELDS`) de "texto fijo", y cuando el valor del campo es `null`/`undefined`/`''`, usa `'Sin historial'` para `dias_sin_pedir` y `'—'` para cualquier otro campo — nunca muestra el nombre interno del campo (ej. la palabra `"dias_sin_pedir"`) como si fuera el mensaje.

- [ ] **Step 1: Agregar el set de campos conocidos**

Busca este bloque exacto:

```js
  const CLIENT_DATA_FIELDS = [
    { key: 'nombre', label: 'Nombre del Cliente' },
    { key: 'dias_sin_pedir', label: 'Días sin pedir' },
    { key: 'zona', label: 'Zona' },
    { key: 'tipo', label: 'Tipo' },
  ];
```

Reemplázalo por:

```js
  const CLIENT_DATA_FIELDS = [
    { key: 'nombre', label: 'Nombre del Cliente' },
    { key: 'dias_sin_pedir', label: 'Días sin pedir' },
    { key: 'zona', label: 'Zona' },
    { key: 'tipo', label: 'Tipo' },
  ];

  const CLIENT_DATA_FIELD_KEYS = new Set(CLIENT_DATA_FIELDS.map(f => f.key));
```

- [ ] **Step 2: Corregir la lógica de reemplazo en `getPreview()`**

Busca este bloque exacto:

```js
      if (mappedValue && client && client[mappedValue]) {
        replacement = client[mappedValue];
      } else if (mappedValue) {
        replacement = mappedValue;
      }
```

Reemplázalo por:

```js
      if (mappedValue && CLIENT_DATA_FIELD_KEYS.has(mappedValue)) {
        const value = client ? client[mappedValue] : undefined;
        if (value !== null && value !== undefined && value !== '') {
          replacement = value;
        } else if (mappedValue === 'dias_sin_pedir') {
          replacement = 'Sin historial';
        } else {
          replacement = '—';
        }
      } else if (mappedValue) {
        replacement = mappedValue;
      }
```

- [ ] **Step 3: Build para verificar que compila**

Run: `cd client && npm run build`
Expected: `✓ built in ...s` sin errores.

- [ ] **Step 4: Verificación manual en el navegador**

No hay framework de test de UI en el proyecto. Verifica a mano: en el Paso 3 del wizard (con cualquier segmento existente), mapea la variable de una plantilla a "Días sin pedir" eligiendo un cliente cuyo `dias_sin_pedir` sea `0` (pidió hoy) — antes del fix, el preview mostraba literalmente la palabra `dias_sin_pedir`; después del fix debe mostrar `0`. Esta misma verificación se repite en la Task 5 con un contacto importado (`dias_sin_pedir = null`), donde debe mostrar `Sin historial`.

- [ ] **Step 5: Commit**

```bash
git add client/src/components/Campaigns.jsx
git commit -m "fix(campañas): getPreview ya no muestra el nombre del campo cuando el valor está vacío o es 0"
```

---

## Task 5: Frontend — segmento "Importar lista externa (CSV)"

**Files:**
- Modify: `client/src/components/Campaigns.jsx`

**Interfaces:**
- Consumes: `POST /api/campaigns/import-contacts` (Task 2), `source` en `POST /api/campaigns/send` (Task 3).
- Produces: nuevo estado `contactSource` (`'clients' | 'campaign_contacts'`), `importMode`, `importing`, `importSummary`. `handleSendCampaign` manda `source: contactSource`.

- [ ] **Step 1: Importar el ícono `Upload`**

Busca esta línea exacta:

```js
import { Megaphone, CheckCircle, XCircle, Clock, CalendarClock, CalendarX, Users, ChevronRight, ArrowLeft } from 'lucide-react';
```

Reemplázala por:

```js
import { Megaphone, CheckCircle, XCircle, Clock, CalendarClock, CalendarX, Users, ChevronRight, ArrowLeft, Upload } from 'lucide-react';
```

- [ ] **Step 2: Agregar el estado nuevo**

Busca este bloque exacto:

```js
  // Selections
  const [segment, setSegment] = useState(null);
  const [filters, setFilters] = useState({ zone: 'all', type: 'all' });
  const [selectedTemplate, setSelectedTemplate] = useState(null);
  const [variableMap, setVariableMap] = useState({});
```

Reemplázalo por:

```js
  // Selections
  const [segment, setSegment] = useState(null);
  const [filters, setFilters] = useState({ zone: 'all', type: 'all' });
  const [selectedTemplate, setSelectedTemplate] = useState(null);
  const [variableMap, setVariableMap] = useState({});
  const [contactSource, setContactSource] = useState('clients');
  const [importMode, setImportMode] = useState(false);
  const [importing, setImporting] = useState(false);
  const [importSummary, setImportSummary] = useState(null);
```

- [ ] **Step 3: Actualizar `resetWizard` y `handleSendCampaign`**

Busca este bloque exacto:

```js
  const resetWizard = () => {
    setStep(1);
    setSegment(null);
    setFilters({ zone: 'all', type: 'all' });
    setSelectedTemplate(null);
    setVariableMap({});
    setEligibleClients([]);
    setCampaignResult(null);
    setError(null);
  };
```

Reemplázalo por:

```js
  const resetWizard = () => {
    setStep(1);
    setSegment(null);
    setFilters({ zone: 'all', type: 'all' });
    setSelectedTemplate(null);
    setVariableMap({});
    setEligibleClients([]);
    setCampaignResult(null);
    setError(null);
    setContactSource('clients');
    setImportMode(false);
    setImportSummary(null);
  };
```

Ahora busca este bloque exacto:

```js
    const payload = {
      template_name: selectedTemplate.name,
      template_language: selectedTemplate.language,
      client_ids: eligibleClients.map(c => c.id),
      variable_mapping: variableMap
    };
```

Reemplázalo por:

```js
    const payload = {
      template_name: selectedTemplate.name,
      template_language: selectedTemplate.language,
      client_ids: eligibleClients.map(c => c.id),
      variable_mapping: variableMap,
      source: contactSource,
    };
```

- [ ] **Step 4: Agregar `handleImportCsv`**

Busca este bloque exacto (el cierre de `fetchClients`/el `useEffect` de clientes elegibles):

```js
    fetchClients();
  }, [segment, filters]);
  
  const resetWizard = () => {
```

Reemplázalo por:

```js
    fetchClients();
  }, [segment, filters]);

  const handleImportCsv = async (file) => {
    setImporting(true);
    setError(null);
    setImportSummary(null);
    try {
      const csvText = await file.text();
      const data = await api.post('/campaigns/import-contacts', { csv: csvText }).then(r => r.data);
      setEligibleClients(data.contacts);
      setImportSummary(data.summary);
      setContactSource('campaign_contacts');
    } catch (err) {
      const msg = err?.response?.data?.error || 'Error al importar el archivo. Intenta de nuevo.';
      setError(msg);
      setEligibleClients([]);
      setImportSummary(null);
    }
    setImporting(false);
  };

  const resetWizard = () => {
```

- [ ] **Step 5: Agregar la tarjeta de importar CSV y su panel en `renderStep1`**

Busca este bloque exacto:

```js
      <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-5 gap-4 mb-6">
        {SEGMENTS.map(s => {
          const isSelected = segment?.key === s.key;
          return (
            <Card key={s.key} onClick={() => setSegment(s)} selected={isSelected}>
              <s.icon size={22} className={`mb-2 ${isSelected ? 'text-orange-600' : 'text-gray-400'}`} />
              <h3 className="font-bold text-base text-left">{s.label}</h3>
            </Card>
          );
        })}
      </div>

      {segment && (
        <>
          <div className="bg-gray-50 rounded-lg p-4 mb-4">
```

Reemplázalo por:

```js
      <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-5 gap-4 mb-6">
        {SEGMENTS.map(s => {
          const isSelected = segment?.key === s.key;
          return (
            <Card
              key={s.key}
              onClick={() => { setSegment(s); setImportMode(false); setImportSummary(null); setContactSource('clients'); }}
              selected={isSelected}
            >
              <s.icon size={22} className={`mb-2 ${isSelected ? 'text-orange-600' : 'text-gray-400'}`} />
              <h3 className="font-bold text-base text-left">{s.label}</h3>
            </Card>
          );
        })}
        <Card
          onClick={() => { setImportMode(true); setSegment(null); setEligibleClients([]); setImportSummary(null); setError(null); }}
          selected={importMode}
        >
          <Upload size={22} className={`mb-2 ${importMode ? 'text-orange-600' : 'text-gray-400'}`} />
          <h3 className="font-bold text-base text-left">Importar lista externa (CSV)</h3>
        </Card>
      </div>

      {importMode && (
        <div className="bg-gray-50 rounded-lg p-4 mb-4">
          <h3 className="text-sm font-semibold text-gray-700 mb-3">Subir archivo CSV</h3>
          <p className="text-xs text-gray-500 mb-3">
            Columnas requeridas: <code>telefono</code>, <code>nombre_o_referencia</code>. Columna opcional: <code>zona</code>.
          </p>
          <input
            type="file"
            accept=".csv"
            disabled={importing}
            onChange={e => {
              const file = e.target.files?.[0];
              if (file) handleImportCsv(file);
            }}
            className="block w-full text-sm text-gray-600"
          />
          {importing && <p className="mt-3 text-sm text-gray-500">Importando…</p>}
          {error && <p className="mt-3 text-red-500 text-sm">{error}</p>}
          {importSummary && (
            <div className="mt-3 text-sm text-gray-700 space-y-1">
              <p><strong>{importSummary.importados}</strong> contactos importados de {importSummary.total_filas} filas.</p>
              {importSummary.ya_cliente > 0 && <p className="text-gray-500">{importSummary.ya_cliente} ya eran clientes (omitidos).</p>}
              {importSummary.ya_importado > 0 && <p className="text-gray-500">{importSummary.ya_importado} ya se habían importado antes (omitidos).</p>}
              {importSummary.invalidas > 0 && <p className="text-gray-500">{importSummary.invalidas} filas inválidas (omitidas).</p>}
            </div>
          )}
          {eligibleClients.length > 0 && importSummary && (
            <button onClick={() => setStep(2)} className="mt-4 bg-orange-500 text-white font-bold py-2 px-4 rounded-lg flex items-center">
              Siguiente <ChevronRight size={20} className="ml-1" />
            </button>
          )}
        </div>
      )}

      {segment && (
        <>
          <div className="bg-gray-50 rounded-lg p-4 mb-4">
```

- [ ] **Step 6: Corregir un crash existente en `renderStep4` (`segment.label` con `segment === null`)**

Cuando la fuente es el CSV importado, `segment` queda `null` — el Paso 4 accede a `segment.label` directamente, lo cual rompería la UI (`Cannot read properties of null`). Busca este bloque exacto:

```js
        <p><strong>Clientes:</strong> {eligibleClients.length} destinatarios del segmento "{segment.label}"</p>
```

Reemplázalo por:

```js
        <p><strong>Clientes:</strong> {eligibleClients.length} destinatarios del segmento "{segment ? segment.label : 'Importar lista externa (CSV)'}"</p>
```

- [ ] **Step 7: Build para verificar que compila**

Run: `cd client && npm run build`
Expected: `✓ built in ...s` sin errores.

- [ ] **Step 8: Verificación manual en el navegador**

Con el backend corriendo, en `/campaigns`:
1. Crea un archivo `prueba.csv` local con contenido:
   ```
   telefono,nombre_o_referencia,zona
   987000111,Prospecto de Prueba,San Borja
   ```
2. En el Paso 1, hacé clic en "Importar lista externa (CSV)", subí el archivo. Debe mostrar el resumen ("1 contactos importados de 1 filas") y el botón "Siguiente".
3. Avanza hasta el Paso 4 y confirmá que el texto dice `"Importar lista externa (CSV)"` en vez de romper la página.
4. Si hay una plantilla con variable mapeada a "Días sin pedir", confirmá que el preview muestra `Sin historial` (no `null`, no la palabra `dias_sin_pedir`).
5. Volvé a subir el mismo archivo — el resumen debe mostrar "0 contactos importados... 1 ya se habían importado antes".

- [ ] **Step 9: Commit**

```bash
git add client/src/components/Campaigns.jsx
git commit -m "feat(campañas): agrega segmento 'Importar lista externa (CSV)' al wizard"
```

---

## Self-Review (completado por quien escribió el plan)

- **Cobertura del spec:** Sección 1 (modelo de datos) → Task 1. Sección 2 (import) → Task 2. Sección 3 (send + campaign_logs 2 fuentes) → Task 3. Sección 4 (fix getPreview) → Task 4. Sección 5 (frontend) → Task 5. El gate final (node --check / npm run build / git status / diff --stat antes del piloto) se ejecuta después de completar las 5 tareas, no es parte de ninguna tarea individual.
- **Corrección de spec:** el spec original decía "agregar a `seed.js`" — corregido en Global Constraints y Task 1 a `server.js`'s `initDb()`, que es lo que realmente importa en runtime y en tests. Confirmado con el usuario antes de escribir el plan.
- **Bug adicional encontrado y corregido:** `renderStep4` accedía a `segment.label` sin verificar null — se rompería con la fuente CSV. Corregido en Task 5, Step 6.
- **Consistencia de tipos/nombres:** `source` (`'clients' | 'campaign_contacts'`) se usa igual en el payload del frontend (Task 5) y en la validación del backend (Task 3). `contacts[].{id,nombre,telefono,zona,tipo,dias_sin_pedir}` (Task 2) coincide exactamente con el shape que ya consumen los Pasos 2-5 existentes. `campaign_contact_id`/`client_id`/`contact_source` se nombran igual en Task 1 (schema), Task 3 (escritura) y serían así también en una futura lectura de historial.
- **Placeholders:** ninguno — todos los pasos tienen código completo, comandos exactos y salidas esperadas.
