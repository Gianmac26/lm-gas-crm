# Mejoras a la Bandeja de WhatsApp — Diseño

**Fecha:** 2026-07-03
**Archivos principales involucrados:** `server.js`, `seed.js`, `client/src/api.js`, `client/src/components/Conversations.jsx`, `client/src/components/ConversationDetail.jsx`

## Contexto

La bandeja de WhatsApp (Conversations/ConversationDetail) ya soporta polling, recibos de lectura, búsqueda, filtros por estado y badge de no leídos. Una revisión del código encontró tres huecos concretos:

1. Mensajes multimedia sin texto (foto, audio, ubicación, documento, sticker, video) se guardan con `body = ''` y se renderizan como burbujas vacías, sin ninguna pista de qué llegó.
2. El campo `wa_conversations.status` ('open'/'closed') existe en el schema y la UI ya lo filtra/muestra, pero **nada en el backend lo pone en `'closed'` jamás** — no hay endpoint ni botón para cerrar o reabrir.
3. Cuando la ventana de atención de 24h de WhatsApp se cierra, el envío de texto falla con `TEMPLATE_REQUIRED` y el chat muestra el error, pero no ofrece ninguna acción — no hay forma de enviar una plantilla aprobada 1 a 1 desde el chat (solo existe el envío masivo en la feature de Campañas, en construcción por otro agente).

Nota importante: hay un agente de Gemini trabajando en paralelo en `server.js` (feature de Campañas masivas). Este diseño evita tocar esa sección del archivo para no pisar su trabajo en curso; donde hay lógica similar (envío de plantilla vía API de Meta) se duplica en vez de refactorizar el código compartido, dejando la unificación como deuda técnica documentada para después.

## Feature 1 — Etiquetas para mensajes multimedia sin texto

**Backend (`server.js`):**
- Agregar `last_message_type` a la subconsulta de `GET /api/conversations` (mismo patrón que `last_message_body`, ver líneas ~1213-1217), para que la lista también pueda mostrar la etiqueta correcta en el preview.

**Frontend:**
- Definir un mapa `MEDIA_LABELS` compartido (o duplicado, dado que son dos archivos pequeños) con estas etiquetas por `type`:
  - `image` → "📷 Foto"
  - `video` → "🎬 Video"
  - `audio` → "🎤 Nota de voz"
  - `document` → "📄 Documento"
  - `sticker` → "😀 Sticker"
  - `location` → "📍 Ubicación"
  - `contacts` → "👤 Contacto"
  - cualquier otro tipo desconocido → "📎 Adjunto"
- En `ConversationDetail.jsx`, al renderizar cada burbuja: si `!m.body && m.type !== 'text'`, mostrar la etiqueta correspondiente en itálica/gris en vez de texto vacío.
- En `Conversations.jsx`, al renderizar el preview del último mensaje: misma lógica usando `c.last_message_type`.
- No requiere llamadas nuevas a la API de Meta ni migraciones (la columna `type` ya existe en `wa_messages`).

**Fuera de alcance (explícito):** no se descarga ni se muestra el archivo real. Para ver la foto/audio hay que abrir WhatsApp Business directamente. Queda como posible fase 2 futura.

## Feature 2 — Cerrar / reabrir conversación

**Backend (`server.js`):**
- Nuevo endpoint `PATCH /api/conversations/:id/status`:
  - Body: `{ status: 'open' | 'closed' }`.
  - Valida que `status` sea uno de los dos valores permitidos (400 si no).
  - 404 si la conversación no existe.
  - Actualiza `wa_conversations.status` y `updated_at`.
  - Devuelve la conversación actualizada.
- Modificar `updateConversationAfterInbound()` (líneas ~842-855): agregar `status = 'open'` al `SET` del `UPDATE`, de forma incondicional. Así, cualquier mensaje entrante nuevo reabre automáticamente una conversación cerrada — nunca se pierde un mensaje de un cliente en una conversación marcada como cerrada.

**Frontend:**
- `client/src/api.js`: agregar `conversations.setStatus(id, status)` → `PATCH /conversations/:id/status`.
- `ConversationDetail.jsx`: botón en el header — "Cerrar conversación" si `status === 'open'`, "Reabrir conversación" si `status === 'closed'`. Al hacer clic, llama al endpoint y actualiza el estado local de `conversation` con la respuesta.
- `Conversations.jsx`: no requiere cambios — los filtros "Abiertas"/"Cerradas" ya existen y ya funcionan, solo que hasta ahora nunca había conversaciones realmente cerradas.

## Feature 3 — Enviar plantilla 1 a 1 desde el chat (solo reactivo)

**Backend (`server.js`):**
- Nueva función `sendWhatsappTemplateMessage({ to, templateName, templateLanguage, components })`, escrita replicando el patrón ya usado en `sendWhatsappTextMessage()` (líneas ~1065+): mismo timeout/abort vía `AbortController`, mismo formato de retorno `{ ok, status, code, message, waMessageId }`, mismo `sanitizeMetaErrorMessage()` para no filtrar el token en logs de error.
- Nuevo endpoint `POST /api/conversations/:id/template`:
  - Body: `{ template_name, template_language, components, body, client_request_id }`.
    - `components`: array en el formato que espera la API de Meta (mismo shape que ya arma `Campaigns.jsx` en el frontend).
    - `body`: texto ya renderizado (plantilla + variables reemplazadas) — se guarda tal cual en `wa_messages.body` solo para que se vea bien en el historial del chat; no se reenvía a Meta como texto libre.
    - `client_request_id`: mismo mecanismo de idempotencia que ya usa el endpoint de texto (`isValidClientRequestId`, chequeo de duplicados).
  - Validaciones: `template_name`/`template_language` no vacíos, teléfono de la conversación válido (`isValidWhatsappPhone`). **No** valida la ventana de 24h — esa es precisamente la vía para saltarla.
  - Inserta en `wa_messages` con `direction: 'outbound'`, `type: 'template'`, `status: 'queued'`.
  - Llama a `sendWhatsappTemplateMessage()`; en éxito actualiza a `status: 'sent'` + `wa_message_id` + `sent_at` y el `last_message_at` de la conversación (mismo patrón que el endpoint de texto); en falla usa `markOutboundMessageFailed()` (función ya existente, reutilizada tal cual).

**Frontend (`ConversationDetail.jsx`):**
- Nuevo estado local: cuando `handleSend()` falla con `errData.error === 'TEMPLATE_REQUIRED'`, en vez de (o además de) mostrar el banner de error actual, reemplazar el área de input por un selector de plantilla:
  1. Fetch de plantillas vía `getApi('/campaigns/templates')` (endpoint ya existente, se reutiliza tal cual).
  2. Dropdown para elegir plantilla (filtrando por idioma español, igual que ya hace el backend).
  3. Si la plantilla tiene variables `{{n}}` en el body, inputs de texto para cada una (mismo regex que ya usa `Campaigns.jsx` paso 3).
  4. Preview en vivo del mensaje final (reutilizar/adaptar la lógica de `getPreview()` de `Campaigns.jsx`).
  5. Botón "Enviar plantilla" → arma `components` en formato Meta + `body` renderizado → `POST /conversations/:id/template`. En éxito, el mensaje aparece como burbuja saliente normal y el input vuelve a su estado de texto normal.
  6. Botón "Cancelar" para volver al input de texto sin enviar nada.
- No se agrega ningún botón permanente para enviar plantillas fuera de este flujo reactivo (decisión explícita del usuario).

## Deuda técnica documentada (no se resuelve en este trabajo)

- `sendWhatsappTemplateMessage()` duplica lógica de envío de plantilla que también existe (de forma menos robusta, sin timeout/abort) en `POST /api/campaigns/send`. Unificar cuando el trabajo de Campañas esté terminado y estable.

## Pruebas

Siguiendo el patrón de `test/orders.debt.test.js` (Node `node:test` + servidor real contra SQLite temporal vía `TURSO_DATABASE_URL` apuntando a un archivo temp):

- **Cerrar/reabrir:** transición válida `open→closed` y `closed→open`, rechazo de valor de `status` inválido (400), 404 sobre conversación inexistente, y verificación de que simular un mensaje entrante sobre una conversación cerrada la vuelve a abrir.
- **Envío de plantilla:** validación de parámetros faltantes/vacíos (400), 404 sobre conversación inexistente, comportamiento cuando `WHATSAPP_ACCESS_TOKEN`/`WHATSAPP_PHONE_NUMBER_ID` no están configurados (rama de config incompleta, sin llamar a la API real de Meta).
- **Etiquetas de media:** es una feature puramente visual de React sin framework de test de frontend en el proyecto — se verifica a mano abriendo la app en el navegador con un mensaje de tipo no-texto de prueba.
