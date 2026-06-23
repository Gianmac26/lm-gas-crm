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

// Local dev entry point
if (require.main === module) {
  const PORT = process.env.PORT || 3001;
  app.listen(PORT, () => console.log(`✅ L&M Gas CRM corriendo en http://localhost:${PORT}`));
}

module.exports = app;
