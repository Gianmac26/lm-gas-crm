# Mejoras a la Bandeja de WhatsApp — Plan de Implementación

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Cerrar 3 huecos concretos en la bandeja de WhatsApp del CRM L&M: mensajes multimedia que se muestran vacíos, imposibilidad de cerrar/reabrir conversaciones, y ausencia de una vía para enviar una plantilla aprobada 1 a 1 cuando la ventana de 24h de WhatsApp expira.

**Architecture:** Todo el trabajo es aditivo sobre el stack existente (Express + SQLite/libSQL en el backend, React + Vite en el frontend). Se reutilizan helpers ya probados (`sendWhatsappTextMessage`, `isValidClientRequestId`, `markOutboundMessageFailed`, etc.) como plantilla para el código nuevo, en vez de introducir abstracciones nuevas.

**Tech Stack:** Node.js + Express + libSQL (`lib/db.js`), React 18 + Vite + Tailwind + lucide-react, pruebas con `node:test` contra un servidor real y una base SQLite temporal (mismo patrón que `test/orders.debt.test.js`).

## Global Constraints

- **No tocar las secciones de `server.js` donde el agente de Gemini está trabajando** (todas las rutas `/api/campaigns/*`, la constante `WABA_ID`, y cualquier código bajo el comentario `// ─── CAMPAIGNS ───`). Todo el código nuevo de este plan se inserta **antes** de ese bloque, entre el endpoint existente `POST /api/conversations/:id/messages` y `PATCH /api/conversations/:id/read`.
- No tocar `client/src/components/Campaigns.jsx` en absoluto.
- Seguir el patrón de pruebas de `test/orders.debt.test.js`: `node:test`, servidor real vía `app.listen(0)`, base temporal vía `TURSO_DATABASE_URL=file:...`.
- Verificación visual de los cambios de frontend a mano en el navegador (`npm run dev` desde la raíz), ya que el proyecto no tiene framework de test de UI.
- Ejecutar `npm test` (backend) después de cada tarea con pruebas automatizadas, y `cd client && npm run build` después de cada tarea de frontend, antes de cada commit.

---

## Task 1: Backend — exponer el tipo del último mensaje en la lista de conversaciones

**Files:**
- Modify: `server.js` (subconsulta de `GET /api/conversations`, líneas ~1208-1227)
- Test: `test/conversations.test.js` (nuevo)

**Interfaces:**
- Produces: cada objeto de `GET /api/conversations` → `conversations[]` ahora incluye el campo `last_message_type` (string, ej. `'text'`, `'image'`, `'audio'`), además de los campos ya existentes (`last_message_body`, `last_message_direction`, `last_message_status`).

- [ ] **Step 1: Escribir el archivo de test con el arnés compartido y el primer test (debe fallar)**

Crear `test/conversations.test.js`:

```js
/**
 * Pruebas de la bandeja de WhatsApp: tipo de último mensaje, cerrar/reabrir
 * conversación, auto-reapertura, y envío de plantilla 1 a 1.
 * Corre contra una base SQLite temporal (no toca producción).
 *   Ejecutar: npm test
 */
const test = require('node:test');
const assert = require('node:assert');
const crypto = require('node:crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');

const TMP_DB = path.join(os.tmpdir(), `lmtest_conversations_${Date.now()}.db`);
process.env.TURSO_DATABASE_URL = 'file:' + TMP_DB;
delete process.env.TURSO_AUTH_TOKEN;
delete process.env.WHATSAPP_ACCESS_TOKEN;
delete process.env.WHATSAPP_PHONE_NUMBER_ID;

const app = require('../server');

let base, server;
let waMessageCounter = 0;

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

async function sendInboundWhatsapp({ phone, contactName = 'Cliente Test', type = 'text', text = 'Hola' }) {
  waMessageCounter += 1;
  const message = {
    from: phone,
    id: `wamid.TEST${waMessageCounter}`,
    timestamp: String(Math.floor(Date.now() / 1000)),
    type,
  };
  if (type === 'text') message.text = { body: text };

  return api('POST', '/webhook/whatsapp', {
    entry: [{
      changes: [{
        value: {
          contacts: [{ wa_id: phone, profile: { name: contactName } }],
          messages: [message],
        },
      }],
    }],
  });
}

async function findConversationByPhone(phone) {
  const digits = phone.replace(/\D/g, '').slice(-9);
  const { data } = await api('GET', `/api/conversations?q=${digits}`);
  return data.conversations.find(c => c.phone_normalized === phone);
}

test('GET /api/conversations incluye last_message_type del último mensaje', async () => {
  const phone = '51911111111';
  await sendInboundWhatsapp({ phone, contactName: 'Multimedia Test', type: 'image' });
  const conv = await findConversationByPhone(phone);
  assert.ok(conv, 'debe existir la conversación');
  assert.equal(conv.last_message_type, 'image');
});
```

- [ ] **Step 2: Correr el test para verificar que falla**

Run: `npm test`
Expected: FAIL — `assert.equal(conv.last_message_type, 'image')` falla porque `conv.last_message_type` es `undefined` (el campo todavía no existe en la respuesta).

- [ ] **Step 3: Agregar `last_message_type` a la subconsulta**

En `server.js`, dentro de `GET /api/conversations`, busca este bloque exacto:

```js
                      (SELECT m.status
                       FROM wa_messages m
                       WHERE m.conversation_id = wc.id
                       ORDER BY datetime(COALESCE(m.created_at, m.received_at)) DESC, m.id DESC
                       LIMIT 1) as last_message_status
               FROM wa_conversations wc
```

Reemplázalo por:

```js
                      (SELECT m.status
                       FROM wa_messages m
                       WHERE m.conversation_id = wc.id
                       ORDER BY datetime(COALESCE(m.created_at, m.received_at)) DESC, m.id DESC
                       LIMIT 1) as last_message_status,
                      (SELECT m.type
                       FROM wa_messages m
                       WHERE m.conversation_id = wc.id
                       ORDER BY datetime(COALESCE(m.created_at, m.received_at)) DESC, m.id DESC
                       LIMIT 1) as last_message_type
               FROM wa_conversations wc
```

- [ ] **Step 4: Correr el test para verificar que pasa**

Run: `npm test`
Expected: PASS — el test `GET /api/conversations incluye last_message_type del último mensaje` pasa.

- [ ] **Step 5: Commit**

```bash
git add server.js test/conversations.test.js
git commit -m "feat(bandeja): expone last_message_type en GET /api/conversations"
```

---

## Task 2: Frontend — etiquetas para mensajes multimedia sin texto

**Files:**
- Modify: `client/src/components/ConversationDetail.jsx`
- Modify: `client/src/components/Conversations.jsx`

**Interfaces:**
- Consumes: `last_message_type` (Task 1, en `Conversations.jsx`) y `m.type` (ya existente en cada mensaje de `GET /api/conversations/:id/messages`, en `ConversationDetail.jsx`).
- Produces: función `mediaLabel(type)` en cada archivo (duplicada intencionalmente — son dos componentes pequeños e independientes) que devuelve un string como `'📷 Foto'`.

- [ ] **Step 1: Agregar el mapa de etiquetas y el bubble de mensaje en `ConversationDetail.jsx`**

Busca este bloque exacto (después de `getErrorText`):

```js
function getErrorText(code, fallback) {
  return ERROR_TEXT[code] || fallback || 'Error al enviar el mensaje. Intenta de nuevo.';
}
```

Reemplázalo por:

```js
function getErrorText(code, fallback) {
  return ERROR_TEXT[code] || fallback || 'Error al enviar el mensaje. Intenta de nuevo.';
}

const MEDIA_LABELS = {
  image: '📷 Foto',
  video: '🎬 Video',
  audio: '🎤 Nota de voz',
  document: '📄 Documento',
  sticker: '😀 Sticker',
  location: '📍 Ubicación',
  contacts: '👤 Contacto',
};

function mediaLabel(type) {
  return MEDIA_LABELS[type] || '📎 Adjunto';
}
```

Ahora busca este bloque exacto (dentro del `.map` de mensajes):

```jsx
                      <p className="whitespace-pre-wrap break-words leading-snug">{m.body}</p>
```

Reemplázalo por:

```jsx
                      <p className={`whitespace-pre-wrap break-words leading-snug ${!m.body && m.type !== 'text' ? 'italic opacity-80' : ''}`}>
                        {m.body || (m.type && m.type !== 'text' ? mediaLabel(m.type) : '')}
                      </p>
```

- [ ] **Step 2: Agregar el mapa de etiquetas y el preview de la lista en `Conversations.jsx`**

Busca este bloque exacto (función `displayName`):

```js
function displayName(c) {
  return c.client_name || c.contact_name || c.phone || c.phone_normalized || '—';
}
```

Reemplázalo por:

```js
function displayName(c) {
  return c.client_name || c.contact_name || c.phone || c.phone_normalized || '—';
}

const MEDIA_LABELS = {
  image: '📷 Foto',
  video: '🎬 Video',
  audio: '🎤 Nota de voz',
  document: '📄 Documento',
  sticker: '😀 Sticker',
  location: '📍 Ubicación',
  contacts: '👤 Contacto',
};

function mediaLabel(type) {
  return MEDIA_LABELS[type] || '📎 Adjunto';
}
```

Ahora busca este bloque exacto (preview del último mensaje):

```jsx
                      {c.last_message_body
                        ? c.last_message_body
                        : <span className="italic">Sin mensajes</span>}
```

Reemplázalo por:

```jsx
                      {c.last_message_body
                        ? c.last_message_body
                        : c.last_message_type && c.last_message_type !== 'text'
                          ? <span className="italic">{mediaLabel(c.last_message_type)}</span>
                          : <span className="italic">Sin mensajes</span>}
```

- [ ] **Step 3: Build para verificar que compila**

Run: `cd client && npm run build`
Expected: `✓ built in ...s` sin errores.

- [ ] **Step 4: Verificación manual en el navegador**

Con el backend corriendo (`npm run dev` desde la raíz del proyecto), simula un mensaje entrante de imagen:

```bash
curl -X POST http://localhost:3001/webhook/whatsapp \
  -H "Content-Type: application/json" \
  -d '{
    "entry": [{"changes": [{"value": {
      "contacts": [{"wa_id": "51999888777", "profile": {"name": "Prueba Foto"}}],
      "messages": [{"from": "51999888777", "id": "wamid.MANUAL1", "timestamp": "'"$(date +%s)"'", "type": "image"}]
    }}]}]
  }'
```

Abre la app en el navegador (`/conversations`), confirma que la conversación "Prueba Foto" muestra "📷 Foto" en el preview de la lista y, al entrar, en la burbuja del mensaje (en vez de aparecer vacía).

- [ ] **Step 5: Commit**

```bash
git add client/src/components/ConversationDetail.jsx client/src/components/Conversations.jsx
git commit -m "feat(bandeja): muestra etiqueta descriptiva para mensajes multimedia sin texto"
```

---

## Task 3: Backend — endpoint para cerrar / reabrir una conversación

**Files:**
- Modify: `server.js` (nuevo endpoint, insertado entre `POST /api/conversations/:id/messages` y `PATCH /api/conversations/:id/read`)
- Test: `test/conversations.test.js`

**Interfaces:**
- Produces: `PATCH /api/conversations/:id/status` — body `{ status: 'open' | 'closed' }` → 200 con la conversación actualizada; 400 si `status` inválido o `:id` inválido; 404 si no existe.

- [ ] **Step 1: Agregar los tests (deben fallar)**

Al final de `test/conversations.test.js`, agrega:

```js

test('PATCH /api/conversations/:id/status cierra y reabre una conversación', async () => {
  const phone = '51922222222';
  await sendInboundWhatsapp({ phone, contactName: 'Cerrar Test' });
  const conv = await findConversationByPhone(phone);
  assert.equal(conv.status, 'open');

  const closed = await api('PATCH', `/api/conversations/${conv.id}/status`, { status: 'closed' });
  assert.equal(closed.status, 200);
  assert.equal(closed.data.status, 'closed');

  const reopened = await api('PATCH', `/api/conversations/${conv.id}/status`, { status: 'open' });
  assert.equal(reopened.status, 200);
  assert.equal(reopened.data.status, 'open');
});

test('PATCH /api/conversations/:id/status rechaza un status inválido', async () => {
  const phone = '51933333333';
  await sendInboundWhatsapp({ phone, contactName: 'Invalido Test' });
  const conv = await findConversationByPhone(phone);
  const res = await api('PATCH', `/api/conversations/${conv.id}/status`, { status: 'archivado' });
  assert.equal(res.status, 400);
});

test('PATCH /api/conversations/:id/status devuelve 404 si la conversación no existe', async () => {
  const res = await api('PATCH', `/api/conversations/999999/status`, { status: 'closed' });
  assert.equal(res.status, 404);
});
```

- [ ] **Step 2: Correr los tests para verificar que fallan**

Run: `npm test`
Expected: FAIL con status 404 en vez de 200/400 (la ruta no existe todavía, Express devuelve 404 por defecto para rutas no registradas).

- [ ] **Step 3: Agregar el endpoint**

En `server.js`, busca este bloque exacto:

```js
    const sentMessage = await getOutboundMessage(messageId);
    return res.status(201).json({ message: sentMessage });
  } catch (err) { return sendInternalError(res, 'Error enviando mensaje de WhatsApp:', err); }
});

app.patch('/api/conversations/:id/read', async (req, res) => {
```

Reemplázalo por:

```js
    const sentMessage = await getOutboundMessage(messageId);
    return res.status(201).json({ message: sentMessage });
  } catch (err) { return sendInternalError(res, 'Error enviando mensaje de WhatsApp:', err); }
});

app.patch('/api/conversations/:id/status', async (req, res) => {
  try {
    const conversationId = parsePositiveInteger(req.params.id);
    if (!conversationId) return res.status(400).json({ error: 'id de conversación inválido' });

    const status = req.body?.status;
    if (!['open', 'closed'].includes(status)) {
      return res.status(400).json({ error: "status debe ser 'open' o 'closed'" });
    }

    const conversation = row(await db.execute({
      sql: 'SELECT id FROM wa_conversations WHERE id = ?',
      args: [conversationId],
    }));
    if (!conversation) return res.status(404).json({ error: 'Conversación no encontrada' });

    await db.execute({
      sql: 'UPDATE wa_conversations SET status = ?, updated_at = ? WHERE id = ?',
      args: [status, isoNow(), conversationId],
    });

    const updated = row(await db.execute({
      sql: 'SELECT * FROM wa_conversations WHERE id = ?',
      args: [conversationId],
    }));
    res.json(updated);
  } catch (err) { return sendInternalError(res, 'Error actualizando estado de conversación:', err); }
});

app.patch('/api/conversations/:id/read', async (req, res) => {
```

- [ ] **Step 4: Correr los tests para verificar que pasan**

Run: `npm test`
Expected: PASS — los 3 tests nuevos pasan, y los tests de Task 1 y `orders.debt.test.js` siguen pasando.

- [ ] **Step 5: Commit**

```bash
git add server.js test/conversations.test.js
git commit -m "feat(bandeja): agrega endpoint PATCH /api/conversations/:id/status para cerrar/reabrir"
```

---

## Task 4: Backend — auto-reapertura al recibir un mensaje entrante

**Files:**
- Modify: `server.js` (función `updateConversationAfterInbound`, líneas ~842-855)
- Test: `test/conversations.test.js`

**Interfaces:**
- Produces: cualquier mensaje entrante nuevo pone `wa_conversations.status = 'open'` incondicionalmente, sin importar el estado previo.

- [ ] **Step 1: Agregar el test (debe fallar)**

Al final de `test/conversations.test.js`, agrega:

```js

test('un mensaje entrante nuevo reabre una conversación cerrada', async () => {
  const phone = '51944444444';
  await sendInboundWhatsapp({ phone, contactName: 'Reabrir Test' });
  const conv = await findConversationByPhone(phone);
  await api('PATCH', `/api/conversations/${conv.id}/status`, { status: 'closed' });

  await sendInboundWhatsapp({ phone, contactName: 'Reabrir Test', text: 'Otro mensaje' });
  const reloaded = await findConversationByPhone(phone);
  assert.equal(reloaded.status, 'open');
});
```

- [ ] **Step 2: Correr el test para verificar que falla**

Run: `npm test`
Expected: FAIL — `reloaded.status` sigue siendo `'closed'` porque `updateConversationAfterInbound` todavía no toca el campo `status`.

- [ ] **Step 3: Modificar `updateConversationAfterInbound`**

En `server.js`, busca este bloque exacto:

```js
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
```

Reemplázalo por:

```js
async function updateConversationAfterInbound({ conversationId, clientId, phone, contactName, at }) {
  await db.execute({
    sql: `UPDATE wa_conversations
          SET client_id = COALESCE(client_id, ?),
              phone = COALESCE(NULLIF(?, ''), phone),
              contact_name = COALESCE(NULLIF(?, ''), contact_name),
              status = 'open',
              last_message_at = ?,
              last_inbound_at = ?,
              unread_count = COALESCE(unread_count, 0) + 1,
              updated_at = ?
          WHERE id = ?`,
    args: [clientId, phone, contactName, at, at, at, conversationId],
  });
}
```

- [ ] **Step 4: Correr el test para verificar que pasa**

Run: `npm test`
Expected: PASS — todos los tests de `test/conversations.test.js` y `test/orders.debt.test.js` pasan.

- [ ] **Step 5: Commit**

```bash
git add server.js test/conversations.test.js
git commit -m "feat(bandeja): un mensaje entrante reabre automáticamente una conversación cerrada"
```

---

## Task 5: Frontend — botón de cerrar / reabrir conversación

**Files:**
- Modify: `client/src/api.js`
- Modify: `client/src/components/ConversationDetail.jsx`

**Interfaces:**
- Consumes: `PATCH /api/conversations/:id/status` (Task 3).
- Produces: `conversationsApi.setStatus(id, status)` en `api.js`, usado por el nuevo botón del header.

- [ ] **Step 1: Agregar `setStatus` a `api.js`**

Busca este bloque exacto:

```js
export const conversations = {
  list:        (params)      => api.get('/conversations', { params }).then(r => r.data),
  unreadCount: ()            => api.get('/conversations/unread-count').then(r => r.data),
  getMessages:(id, params)   => api.get(`/conversations/${id}/messages`, { params }).then(r => r.data),
  send:       (id, data)     => api.post(`/conversations/${id}/messages`, data).then(r => r.data),
  markRead:   (id)           => api.patch(`/conversations/${id}/read`).then(r => r.data),
};
```

Reemplázalo por:

```js
export const conversations = {
  list:        (params)      => api.get('/conversations', { params }).then(r => r.data),
  unreadCount: ()            => api.get('/conversations/unread-count').then(r => r.data),
  getMessages:(id, params)   => api.get(`/conversations/${id}/messages`, { params }).then(r => r.data),
  send:       (id, data)     => api.post(`/conversations/${id}/messages`, data).then(r => r.data),
  markRead:   (id)           => api.patch(`/conversations/${id}/read`).then(r => r.data),
  setStatus:  (id, status)   => api.patch(`/conversations/${id}/status`, { status }).then(r => r.data),
};
```

- [ ] **Step 2: Importar los íconos `Lock`/`Unlock` en `ConversationDetail.jsx`**

Busca esta línea exacta:

```js
import { ChevronLeft, Send, Check, CheckCheck, Clock, AlertCircle, User } from 'lucide-react';
```

Reemplázala por:

```js
import { ChevronLeft, Send, Check, CheckCheck, Clock, AlertCircle, User, Lock, Unlock } from 'lucide-react';
```

- [ ] **Step 3: Agregar el estado y la función `toggleStatus`**

Busca este bloque exacto:

```js
  const [sending, setSending] = useState(false);
  const [sendError, setSendError] = useState(null);
```

Reemplázalo por:

```js
  const [sending, setSending] = useState(false);
  const [sendError, setSendError] = useState(null);
  const [statusUpdating, setStatusUpdating] = useState(false);
```

Ahora busca este bloque exacto (justo antes de `if (loading) {`):

```js
  const handleKeyDown = e => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      handleSend();
    }
  };

  if (loading) {
```

Reemplázalo por:

```js
  const handleKeyDown = e => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      handleSend();
    }
  };

  const toggleStatus = async () => {
    if (!conversation || statusUpdating) return;
    const nextStatus = conversation.status === 'closed' ? 'open' : 'closed';
    setStatusUpdating(true);
    try {
      const updated = await conversationsApi.setStatus(convId, nextStatus);
      setConversation(updated);
    } catch { /* no crítico, el estado local no cambia */ }
    setStatusUpdating(false);
  };

  if (loading) {
```

- [ ] **Step 4: Agregar el botón en el header**

Busca este bloque exacto:

```jsx
        {conversation?.client_id && (
          <button
            onClick={() => nav(`/clients/${conversation.client_id}`)}
            className="btn-ghost !py-2 !px-3 flex items-center gap-1.5 text-xs flex-shrink-0"
          >
            <User size={14} /> Ficha
          </button>
        )}
      </div>
```

Reemplázalo por:

```jsx
        {conversation?.client_id && (
          <button
            onClick={() => nav(`/clients/${conversation.client_id}`)}
            className="btn-ghost !py-2 !px-3 flex items-center gap-1.5 text-xs flex-shrink-0"
          >
            <User size={14} /> Ficha
          </button>
        )}
        <button
          onClick={toggleStatus}
          disabled={statusUpdating}
          className="btn-ghost !py-2 !px-3 flex items-center gap-1.5 text-xs flex-shrink-0"
        >
          {conversation?.status === 'closed' ? <Unlock size={14} /> : <Lock size={14} />}
          {conversation?.status === 'closed' ? 'Reabrir' : 'Cerrar'}
        </button>
      </div>
```

- [ ] **Step 5: Build para verificar que compila**

Run: `cd client && npm run build`
Expected: `✓ built in ...s` sin errores.

- [ ] **Step 6: Verificación manual en el navegador**

Abre una conversación en `/conversations/:id`, haz clic en "Cerrar", confirma que el botón cambia a "Reabrir" y que al recargar la página el estado persiste. Confirma también que el filtro "Cerradas" en `/conversations` ahora sí muestra esa conversación.

- [ ] **Step 7: Commit**

```bash
git add client/src/api.js client/src/components/ConversationDetail.jsx
git commit -m "feat(bandeja): botón para cerrar/reabrir una conversación"
```

---

## Task 6: Backend — envío de plantilla 1 a 1

**Files:**
- Modify: `server.js` (nueva función `sendWhatsappTemplateMessage` después de `sendWhatsappTextMessage`; nuevo endpoint `POST /api/conversations/:id/template` en la misma zona segura que Task 3)
- Test: `test/conversations.test.js`

**Interfaces:**
- Produces: `sendWhatsappTemplateMessage({ to, templateName, templateLanguage, components })` → `{ ok, status, code, message, waMessageId }` (mismo shape que `sendWhatsappTextMessage`).
- Produces: `POST /api/conversations/:id/template` — body `{ template_name, template_language, components, body, client_request_id }` → 201 con `{ message }` en éxito; 400 en validación; 404 si la conversación no existe; 422 si el teléfono es inválido; el código de error de Meta (ej. 500 `WHATSAPP_CONFIG_MISSING`) si falla el envío.

- [ ] **Step 1: Agregar los tests (deben fallar)**

Al final de `test/conversations.test.js`, agrega:

```js

test('POST /api/conversations/:id/template valida parámetros requeridos', async () => {
  const phone = '51955555555';
  await sendInboundWhatsapp({ phone, contactName: 'Plantilla Test' });
  const conv = await findConversationByPhone(phone);

  const res = await api('POST', `/api/conversations/${conv.id}/template`, {
    template_language: 'es',
    components: [],
    body: 'Hola',
    client_request_id: crypto.randomUUID(),
  });
  assert.equal(res.status, 400);
});

test('POST /api/conversations/:id/template devuelve 404 si la conversación no existe', async () => {
  const res = await api('POST', `/api/conversations/999999/template`, {
    template_name: 'reactivacion',
    template_language: 'es',
    components: [],
    body: 'Hola',
    client_request_id: crypto.randomUUID(),
  });
  assert.equal(res.status, 404);
});

test('POST /api/conversations/:id/template falla con WHATSAPP_CONFIG_MISSING si no hay credenciales', async () => {
  const phone = '51966666666';
  await sendInboundWhatsapp({ phone, contactName: 'Sin Config Test' });
  const conv = await findConversationByPhone(phone);

  const res = await api('POST', `/api/conversations/${conv.id}/template`, {
    template_name: 'reactivacion',
    template_language: 'es',
    components: [],
    body: 'Hola de nuevo',
    client_request_id: crypto.randomUUID(),
  });
  assert.equal(res.status, 500);
  assert.equal(res.data.error, 'WHATSAPP_CONFIG_MISSING');
});
```

- [ ] **Step 2: Correr los tests para verificar que fallan**

Run: `npm test`
Expected: FAIL con status 404 en los 3 (la ruta no existe todavía).

- [ ] **Step 3: Agregar `sendWhatsappTemplateMessage`**

En `server.js`, busca este bloque exacto (el cierre de `sendWhatsappTextMessage`, justo antes del comentario del webhook):

```js
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
```

Reemplázalo por:

```js
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

async function sendWhatsappTemplateMessage({ to, templateName, templateLanguage, components }) {
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
        type: 'template',
        template: {
          name: templateName,
          language: { code: templateLanguage },
          components: components || [],
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
        code: 'META_NO_MESSAGE_ID',
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
```

- [ ] **Step 4: Agregar el endpoint `POST /api/conversations/:id/template`**

Busca este bloque exacto (justo antes de `PATCH /api/conversations/:id/read`, después del endpoint de Task 3):

```js
    const updated = row(await db.execute({
      sql: 'SELECT * FROM wa_conversations WHERE id = ?',
      args: [conversationId],
    }));
    res.json(updated);
  } catch (err) { return sendInternalError(res, 'Error actualizando estado de conversación:', err); }
});

app.patch('/api/conversations/:id/read', async (req, res) => {
```

Reemplázalo por:

```js
    const updated = row(await db.execute({
      sql: 'SELECT * FROM wa_conversations WHERE id = ?',
      args: [conversationId],
    }));
    res.json(updated);
  } catch (err) { return sendInternalError(res, 'Error actualizando estado de conversación:', err); }
});

app.post('/api/conversations/:id/template', async (req, res) => {
  try {
    const conversationId = parsePositiveInteger(req.params.id);
    if (!conversationId) return res.status(400).json({ error: 'id de conversación inválido' });

    const templateName = typeof req.body?.template_name === 'string' ? req.body.template_name.trim() : '';
    const templateLanguage = typeof req.body?.template_language === 'string' ? req.body.template_language.trim() : '';
    const bodyText = typeof req.body?.body === 'string' ? req.body.body.trim() : '';
    const components = Array.isArray(req.body?.components) ? req.body.components : [];
    const clientRequestId = typeof req.body?.client_request_id === 'string'
      ? req.body.client_request_id.trim()
      : '';

    if (!templateName || !templateLanguage) {
      return res.status(400).json({ error: 'template_name y template_language son requeridos' });
    }
    if (!bodyText) {
      return res.status(400).json({ error: 'body debe ser un texto no vacío' });
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
      sql: 'SELECT * FROM wa_conversations WHERE id = ?',
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

    const createdAt = isoNow();
    const insertResult = await db.execute({
      sql: `INSERT OR IGNORE INTO wa_messages
              (conversation_id, client_id, phone, phone_normalized, message, body, direction,
               type, client_request_id, status, created_at)
            VALUES (?, ?, ?, ?, ?, ?, 'outbound', 'template', ?, 'queued', ?)`,
      args: [
        conversation.id,
        conversation.client_id || null,
        conversation.phone || phoneNormalized,
        phoneNormalized,
        bodyText,
        bodyText,
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
    const metaResult = await sendWhatsappTemplateMessage({
      to: phoneNormalized,
      templateName,
      templateLanguage,
      components,
    });

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
  } catch (err) { return sendInternalError(res, 'Error enviando plantilla de WhatsApp:', err); }
});

app.patch('/api/conversations/:id/read', async (req, res) => {
```

- [ ] **Step 5: Correr los tests para verificar que pasan**

Run: `npm test`
Expected: PASS — todos los tests de `test/conversations.test.js` y `test/orders.debt.test.js` pasan.

- [ ] **Step 6: Commit**

```bash
git add server.js test/conversations.test.js
git commit -m "feat(bandeja): agrega envío de plantilla 1 a 1 (POST /api/conversations/:id/template)"
```

---

## Task 7: Frontend — selector de plantilla reactivo en el chat

**Files:**
- Modify: `client/src/api.js`
- Modify: `client/src/components/ConversationDetail.jsx`

**Interfaces:**
- Consumes: `GET /api/campaigns/templates` (endpoint ya existente de la feature de Campañas, se consume vía `api.get` sin tocar el archivo `Campaigns.jsx`), `POST /api/conversations/:id/template` (Task 6).
- Produces: `conversationsApi.sendTemplate(id, data)` en `api.js`; el textarea de `ConversationDetail.jsx` se reemplaza por un selector de plantilla cuando un envío de texto falla con `TEMPLATE_REQUIRED`.

- [ ] **Step 1: Agregar `sendTemplate` a `api.js`**

Busca este bloque exacto:

```js
  markRead:   (id)           => api.patch(`/conversations/${id}/read`).then(r => r.data),
  setStatus:  (id, status)   => api.patch(`/conversations/${id}/status`, { status }).then(r => r.data),
};
```

Reemplázalo por:

```js
  markRead:   (id)           => api.patch(`/conversations/${id}/read`).then(r => r.data),
  setStatus:  (id, status)   => api.patch(`/conversations/${id}/status`, { status }).then(r => r.data),
  sendTemplate: (id, data)   => api.post(`/conversations/${id}/template`, data).then(r => r.data),
};
```

- [ ] **Step 2: Importar el cliente axios por defecto en `ConversationDetail.jsx`**

Busca esta línea exacta:

```js
import { conversations as conversationsApi } from '../api.js';
```

Reemplázala por:

```js
import { conversations as conversationsApi } from '../api.js';
import api from '../api.js';
```

- [ ] **Step 3: Agregar los helpers de plantilla (funciones a nivel de módulo)**

Busca este bloque exacto (el que agregó la Task 2, justo después de `mediaLabel`):

```js
function mediaLabel(type) {
  return MEDIA_LABELS[type] || '📎 Adjunto';
}
```

Reemplázalo por:

```js
function mediaLabel(type) {
  return MEDIA_LABELS[type] || '📎 Adjunto';
}

function extractTemplateVariables(template) {
  const bodyText = template?.components?.find(c => c.type === 'BODY')?.text || '';
  return (bodyText.match(/\{\{[0-9]+\}\}/g) || []).map(v => v.replace(/\{|\}/g, ''));
}

function renderTemplateText(template, vars) {
  const bodyComponent = template?.components?.find(c => c.type === 'BODY');
  let text = bodyComponent?.text || '';
  extractTemplateVariables(template).forEach(key => {
    text = text.split(`{{${key}}}`).join(vars[key] || `{{${key}}}`);
  });
  return text;
}

function renderTemplatePreviewNodes(template, vars) {
  const bodyComponent = template?.components?.find(c => c.type === 'BODY');
  const text = bodyComponent?.text || '';
  if (!text) return 'No hay preview disponible.';

  let parts = [text];
  extractTemplateVariables(template).forEach(key => {
    const placeholder = `{{${key}}}`;
    const replacement = vars[key] || placeholder;
    parts = parts.flatMap(part => {
      if (typeof part !== 'string') return [part];
      const idx = part.indexOf(placeholder);
      if (idx === -1) return [part];
      return [part.slice(0, idx), <strong key={`tvar-${key}`}>{replacement}</strong>, part.slice(idx + placeholder.length)];
    });
  });
  return parts;
}
```

- [ ] **Step 4: Agregar el estado de plantilla**

Busca este bloque exacto (agregado por la Task 5):

```js
  const [statusUpdating, setStatusUpdating] = useState(false);
```

Reemplázalo por:

```js
  const [statusUpdating, setStatusUpdating] = useState(false);
  const [templateMode, setTemplateMode] = useState(false);
  const [templates, setTemplates] = useState([]);
  const [templatesLoading, setTemplatesLoading] = useState(false);
  const [templatesError, setTemplatesError] = useState(null);
  const [selectedTemplate, setSelectedTemplate] = useState(null);
  const [templateVars, setTemplateVars] = useState({});
  const [templateSending, setTemplateSending] = useState(false);
```

- [ ] **Step 5: Disparar el modo plantilla cuando falla con `TEMPLATE_REQUIRED`**

Busca este bloque exacto (catch de `handleSend`):

```js
    } catch (err) {
      const errData = err?.response?.data;
      const code    = errData?.error;
      const msg     = errData?.message;
      setSendError(getErrorText(code, msg));
      if (errData?.whatsapp_message) {
        setMessages(prev => {
          const exists = prev.some(m => m.id === errData.whatsapp_message.id);
          return exists ? prev : [...prev, errData.whatsapp_message];
        });
      }
    } finally {
      setSending(false);
    }
  };
```

Reemplázalo por:

```js
    } catch (err) {
      const errData = err?.response?.data;
      const code    = errData?.error;
      const msg     = errData?.message;
      setSendError(getErrorText(code, msg));
      if (errData?.whatsapp_message) {
        setMessages(prev => {
          const exists = prev.some(m => m.id === errData.whatsapp_message.id);
          return exists ? prev : [...prev, errData.whatsapp_message];
        });
      }
      if (code === 'TEMPLATE_REQUIRED') {
        openTemplatePicker();
      }
    } finally {
      setSending(false);
    }
  };

  const openTemplatePicker = async () => {
    setTemplateMode(true);
    setTemplatesError(null);
    setTemplatesLoading(true);
    try {
      const data = await api.get('/campaigns/templates').then(r => r.data);
      setTemplates(data);
    } catch (err) {
      setTemplatesError('No se pudieron cargar las plantillas. ' + err.message);
    }
    setTemplatesLoading(false);
  };

  const selectTemplate = (template) => {
    setSelectedTemplate(template);
    const variables = extractTemplateVariables(template);
    const initialVars = {};
    variables.forEach((key, idx) => {
      initialVars[key] = idx === 0 ? name : '';
    });
    setTemplateVars(initialVars);
  };

  const cancelTemplateMode = () => {
    setTemplateMode(false);
    setSelectedTemplate(null);
    setTemplateVars({});
    setTemplatesError(null);
  };

  const handleSendTemplate = async () => {
    if (!selectedTemplate || templateSending) return;
    const variables = extractTemplateVariables(selectedTemplate);
    const bodyText = renderTemplateText(selectedTemplate, templateVars);
    const components = variables.length > 0
      ? [{ type: 'body', parameters: variables.map(key => ({ type: 'text', text: templateVars[key] || '' })) }]
      : [];

    setTemplateSending(true);
    setSendError(null);
    try {
      const data = await conversationsApi.sendTemplate(convId, {
        template_name: selectedTemplate.name,
        template_language: selectedTemplate.language,
        components,
        body: bodyText,
        client_request_id: crypto.randomUUID(),
      });
      setMessages(prev => {
        const exists = prev.some(m => m.id === data.message.id);
        return exists ? prev : [...prev, data.message];
      });
      isNearBottomRef.current = true;
      cancelTemplateMode();
    } catch (err) {
      const errData = err?.response?.data;
      setSendError(getErrorText(errData?.error, errData?.message));
    }
    setTemplateSending(false);
  };
```

> **Nota:** este bloque usa la variable `name` (nombre para mostrar de la conversación), que ya se calcula más abajo en el componente como `const name = conversation?.client_name || ...`. Como `selectTemplate` es una función declarada con `const` dentro del cuerpo del componente, se re-crea en cada render y sí tiene acceso a `name` por clausura — no hace falta moverla de lugar.

- [ ] **Step 6: Reemplazar el área de input por el selector de plantilla cuando corresponda**

Busca este bloque exacto (el bloque completo `{/* Input */}`):

```jsx
      {/* Input */}
      <div className="flex-shrink-0 px-4 py-3 bg-white dark:bg-gray-800 border-t border-gray-200 dark:border-gray-700">
        <div className="flex items-end gap-2">
          <textarea
            ref={textareaRef}
            className="input flex-1 !py-2.5 resize-none text-sm leading-snug"
            style={{ minHeight: '42px', maxHeight: '120px', overflowY: 'auto' }}
            placeholder="Escribe un mensaje…"
            value={text}
            onChange={e => {
              setText(e.target.value);
              setSendError(null);
              autoResizeTextarea();
            }}
            onKeyDown={handleKeyDown}
            disabled={sending}
            rows={1}
          />
          <button
            onClick={handleSend}
            disabled={!text.trim() || sending}
            className={`flex-shrink-0 w-11 h-11 rounded-xl flex items-center justify-center transition-colors touch-manipulation
              ${!text.trim() || sending
                ? 'bg-gray-100 dark:bg-gray-700 text-gray-300 dark:text-gray-500 cursor-not-allowed'
                : 'bg-orange-500 hover:bg-orange-600 active:bg-orange-700 text-white'}`}
          >
            <Send size={18} />
          </button>
        </div>
      </div>
```

Reemplázalo por:

```jsx
      {/* Input */}
      {templateMode ? (
        <div className="flex-shrink-0 px-4 py-3 bg-white dark:bg-gray-800 border-t border-gray-200 dark:border-gray-700 space-y-3">
          <p className="text-xs text-gray-500 dark:text-gray-400">
            La ventana de 24h para mensajes libres terminó. Elegí una plantilla aprobada para reactivar la conversación.
          </p>
          {templatesLoading && <p className="text-sm text-gray-500 dark:text-gray-400">Cargando plantillas…</p>}
          {templatesError && <p className="text-sm text-red-500">{templatesError}</p>}
          {!templatesLoading && !templatesError && (
            <select
              className="input text-sm"
              value={selectedTemplate?.name || ''}
              onChange={e => {
                const t = templates.find(t => t.name === e.target.value);
                if (t) selectTemplate(t);
              }}
            >
              <option value="">Elegir plantilla…</option>
              {templates.map(t => <option key={t.name} value={t.name}>{t.name}</option>)}
            </select>
          )}
          {selectedTemplate && (
            <>
              {extractTemplateVariables(selectedTemplate).map(key => (
                <input
                  key={key}
                  type="text"
                  className="input text-sm"
                  placeholder={`Variable {{${key}}}`}
                  value={templateVars[key] || ''}
                  onChange={e => setTemplateVars(v => ({ ...v, [key]: e.target.value }))}
                />
              ))}
              <div className="bg-gray-50 dark:bg-gray-700 p-3 rounded-xl text-sm text-gray-800 dark:text-gray-100">
                {renderTemplatePreviewNodes(selectedTemplate, templateVars)}
              </div>
            </>
          )}
          <div className="flex justify-end gap-2">
            <button onClick={cancelTemplateMode} className="btn-ghost !py-2 !px-3 text-xs">Cancelar</button>
            <button
              onClick={handleSendTemplate}
              disabled={!selectedTemplate || templateSending}
              className={`px-4 py-2 rounded-xl text-xs font-semibold text-white ${!selectedTemplate || templateSending ? 'bg-gray-300 dark:bg-gray-600 cursor-not-allowed' : 'bg-orange-500 hover:bg-orange-600'}`}
            >
              {templateSending ? 'Enviando…' : 'Enviar plantilla'}
            </button>
          </div>
        </div>
      ) : (
        <div className="flex-shrink-0 px-4 py-3 bg-white dark:bg-gray-800 border-t border-gray-200 dark:border-gray-700">
          <div className="flex items-end gap-2">
            <textarea
              ref={textareaRef}
              className="input flex-1 !py-2.5 resize-none text-sm leading-snug"
              style={{ minHeight: '42px', maxHeight: '120px', overflowY: 'auto' }}
              placeholder="Escribe un mensaje…"
              value={text}
              onChange={e => {
                setText(e.target.value);
                setSendError(null);
                autoResizeTextarea();
              }}
              onKeyDown={handleKeyDown}
              disabled={sending}
              rows={1}
            />
            <button
              onClick={handleSend}
              disabled={!text.trim() || sending}
              className={`flex-shrink-0 w-11 h-11 rounded-xl flex items-center justify-center transition-colors touch-manipulation
                ${!text.trim() || sending
                  ? 'bg-gray-100 dark:bg-gray-700 text-gray-300 dark:text-gray-500 cursor-not-allowed'
                  : 'bg-orange-500 hover:bg-orange-600 active:bg-orange-700 text-white'}`}
            >
              <Send size={18} />
            </button>
          </div>
        </div>
      )}
```

- [ ] **Step 7: Build para verificar que compila**

Run: `cd client && npm run build`
Expected: `✓ built in ...s` sin errores.

- [ ] **Step 8: Verificación manual en el navegador**

No es posible simular el error `TEMPLATE_REQUIRED` sin manipular la base de datos, así que verifica manualmente en dos pasos:
1. En la app, abre cualquier conversación y confirma que el chat normal sigue funcionando igual (textarea visible, sin regresión).
2. Verifica el flujo de plantilla llamando directamente al backend simulando la condición de ventana cerrada: actualiza `last_inbound_at` de una conversación de prueba a una fecha de hace más de 24 horas directamente en la base SQLite (`database/lm_gas.db`) con:
   ```sql
   UPDATE wa_conversations SET last_inbound_at = datetime('now', '-2 days') WHERE id = <id-de-prueba>;
   ```
   Luego, en esa conversación, intenta enviar un mensaje de texto normal — debe aparecer el selector de plantilla en vez del textarea. Elige una plantilla, completa las variables, confirma que el preview se ve bien, y envía (si no hay `WHATSAPP_ACCESS_TOKEN` configurado en local, el envío fallará con un error visible, lo cual es el comportamiento esperado — confirma que el error se muestra de forma clara en vez de romper la UI).

- [ ] **Step 9: Commit**

```bash
git add client/src/api.js client/src/components/ConversationDetail.jsx
git commit -m "feat(bandeja): selector de plantilla reactivo cuando expira la ventana de 24h"
```

---

## Self-Review (completado por quien escribió el plan)

- **Cobertura del spec:** Feature 1 → Tasks 1-2. Feature 2 → Tasks 3-4-5. Feature 3 → Tasks 6-7. Las 3 features del spec `2026-07-03-bandeja-whatsapp-mejoras-design.md` están cubiertas.
- **Zona de Campañas:** todas las inserciones de `server.js` (Tasks 1, 3, 4, 6) están ancladas entre `POST /api/conversations/:id/messages` y `PATCH /api/conversations/:id/read` (Tasks 3 y 6) o dentro de funciones existentes fuera de esa zona (Tasks 1 y 4) — ninguna toca el bloque `// ─── CAMPAIGNS ───` ni `Campaigns.jsx`.
- **Consistencia de tipos/nombres:** `sendWhatsappTemplateMessage` devuelve el mismo shape `{ ok, status, code, message, waMessageId }` que `sendWhatsappTextMessage`, consumido igual por el endpoint (Task 6). `conversationsApi.setStatus`/`sendTemplate` (api.js, Tasks 5 y 7) coinciden exactamente con las rutas registradas en Tasks 3 y 6. `mediaLabel`/`MEDIA_LABELS` (Task 2) se reutilizan sin cambios de firma en Task 7 (a través de `extractTemplateVariables`, que es independiente).
- **Placeholders:** ninguno — todos los pasos tienen código completo, comandos exactos y salidas esperadas.
