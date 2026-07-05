# Importar lista externa (CSV) en Campañas — Diseño

**Fecha:** 2026-07-04
**Archivos principales involucrados:** `seed.js`, `server.js`, `client/src/components/Campaigns.jsx`

## Contexto

El wizard de Campañas Masivas de WhatsApp (`client/src/components/Campaigns.jsx`) permite hoy elegir un segmento de clientes ya existentes en la tabla `clients` (inactivos 7/14/30/60 días, o todos), filtrar por zona/tipo, y enviarles una plantilla aprobada de Meta. El usuario necesita una fuente de destinatarios adicional: subir un CSV con una lista externa de contactos (prospectos que aún no son clientes) para campañas de reactivación/captación.

**Decisión de alcance:** los contactos importados van a una tabla nueva y separada, `campaign_contacts` — **no** se insertan en `clients`. El usuario va a importar tandas sucesivas de miles de contactos en las próximas semanas y no quiere que estos prospectos sin verificar contaminen sus reportes de negocio (zonas, conteo de clientes, ticket promedio), que leen de `clients`.

**Fuera de alcance (explícitamente diferido):** la "graduación" automática de un contacto de `campaign_contacts` a `clients` cuando confirma un pedido real por WhatsApp. El usuario decidió abordar esto después del piloto de 40 contactos, con datos reales de cómo responde la gente. Por ahora, si alguien del piloto confirma un pedido, se agrega manualmente al CRM como cualquier cliente nuevo. Este diseño no incluye esa lógica ni deja hooks a medio construir para ella.

## 1. Modelo de datos

Nueva tabla en `seed.js` (agregar al array de `db.batch(...)` en `ensureSchema()`, junto a las demás `CREATE TABLE IF NOT EXISTS`):

```sql
CREATE TABLE IF NOT EXISTS campaign_contacts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  phone TEXT NOT NULL,
  phone_normalized TEXT NOT NULL UNIQUE,
  nombre TEXT NOT NULL,
  zona TEXT,
  import_batch TEXT NOT NULL,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP
)
```

- `phone_normalized UNIQUE` refuerza a nivel de base de datos la regla de negocio "nunca reenviar a alguien ya contactado en una tanda anterior" (protege el quality rating del número de WhatsApp). La validación explícita en el import da además un mensaje de error legible por fila, en vez de depender solo de que la base rechace el `INSERT`.
- `zona` es la zona geográfica real (opcional, viene del CSV) — sirve para comparar performance entre zonas en tandas futuras. Es un campo distinto de `import_batch`.
- `import_batch` identifica de qué importación vino cada contacto (formato `IMPORTADO_YYYY-MM-DD`), para trazabilidad.

Extensión de la tabla existente `campaign_logs` (vía `ensureColumn`, mismo patrón que ya usa `seed.js` para evolucionar tablas sin romper bases ya migradas):

```js
['contact_source', "TEXT NOT NULL DEFAULT 'clients'"],
['campaign_contact_id', 'INTEGER REFERENCES campaign_contacts(id)'],
```

`client_id` (columna ya existente) pasa a ser conceptualmente opcional: se llena solo cuando `contact_source = 'clients'`; cuando `contact_source = 'campaign_contacts'`, `client_id` queda `NULL` y se llena `campaign_contact_id` en su lugar. **Nunca se mezclan los dos espacios de IDs** — esto es deliberado: el usuario planea cruzar `campaign_logs` con `orders` más adelante para medir costo por pedido reactivado, y un `client_id` mal atribuido (un id de `campaign_contacts` interpretado como id de `clients`) rompería esa métrica sin dar ningún error visible.

## 2. Backend — `POST /api/campaigns/import-contacts`

**Request:** `{ csv: "<contenido completo del archivo, como texto plano>" }`

**Validación de archivo completo (antes de procesar filas — responde 400 con `error` descriptivo si falla cualquiera de estas):**
1. `csv` vacío o solo espacios → `"El archivo está vacío."`
2. Primera línea (headers) no contiene, insensible a mayúsculas/espacios, las columnas `telefono` y `nombre_o_referencia` → `"El CSV debe tener las columnas 'telefono' y 'nombre_o_referencia'. Encontradas: <headers detectados, unidos por coma>."`
3. No hay ninguna fila de datos después del header → `"El archivo no tiene filas de datos, solo encabezado."`

**Parseo:** separador coma, sin librería nueva (split simple por línea y por coma — los datos esperados, teléfono/nombre/zona, no llevan comas embebidas). La columna `zona` es opcional; si la fila no la trae, `zona` queda `NULL`.

**Por cada fila de datos, en este orden:**
1. Normaliza el teléfono con `normalizePhone()` (reutilizada de `lib/db.js`, la misma que usa todo el flujo de WhatsApp). Si no resulta un número válido (`isValidWhatsappPhone`) → cuenta como **inválida**, no se inserta.
2. Si `phone_normalized` ya existe en `clients.phone_normalized` → cuenta como **ya es cliente**, no se inserta.
3. Si `phone_normalized` ya existe en `campaign_contacts.phone_normalized` (de esta importación o de una anterior) → cuenta como **ya importado antes**, no se inserta.
4. Si pasa todo: `INSERT INTO campaign_contacts (phone, phone_normalized, nombre, zona, import_batch) VALUES (...)`, con `import_batch = 'IMPORTADO_' + fecha de hoy (YYYY-MM-DD)`.

Las filas se procesan **en orden, una por una** (no en batch) — si el mismo teléfono aparece dos veces dentro del mismo archivo, la primera aparición se inserta normalmente y la segunda se detecta como duplicado en el paso 3 (ya existe en `campaign_contacts`, porque la primera ya se insertó momentos antes), contando como **ya importado antes**. No hace falta una pasada extra para detectar duplicados internos del archivo.

**Response (200):**
```json
{
  "import_batch": "IMPORTADO_2026-07-04",
  "contacts": [
    { "id": 1, "nombre": "Juan Pérez", "telefono": "51987654321", "zona": "San Borja", "tipo": null, "dias_sin_pedir": null }
  ],
  "summary": { "total_filas": 45, "importados": 40, "ya_cliente": 2, "ya_importado": 2, "invalidas": 1 }
}
```

El array `contacts` ya viene en el mismo shape que consumen los Pasos 2-5 del wizard (`id, nombre, telefono, zona, tipo, dias_sin_pedir`) — `tipo` y `dias_sin_pedir` van siempre `null` para esta fuente, ya que no aplican a un contacto recién importado sin historial de pedidos.

## 3. Backend — extender `POST /api/campaigns/send` y `campaign_logs` para 2 fuentes

- El request de envío suma un campo `source: 'clients' | 'campaign_contacts'` (default `'clients'` si no viene, por compatibilidad con el flujo existente).
- Si `source === 'campaign_contacts'`, la consulta que hoy arma `clientData` (para sacar nombre/teléfono antes de enviar) apunta a `campaign_contacts` en vez de `clients`, con `dias_sin_pedir` fijo en `null` (no hay tal columna en esa tabla).
- Al escribir en `campaign_logs`, se guarda `contact_source` y, según corresponda, `client_id` o `campaign_contact_id` (nunca ambos, ver sección 1).

## 4. Corrección necesaria en `getPreview()` (Campaigns.jsx)

Bug encontrado durante el diseño, no solo relacionado al import: hoy, si el valor de un campo mapeado es "falsy" (`null`, `undefined`, o el número `0`), el código muestra literalmente el **nombre interno del campo** (ej. la palabra `"dias_sin_pedir"`) como texto del mensaje — esto ya pasaba con un cliente real que pidió hoy (0 días sin pedir), y pasaría siempre con contactos importados (`dias_sin_pedir` siempre `null`).

Fix: distinguir explícitamente "el usuario mapeó un campo de cliente conocido" (`CLIENT_DATA_FIELDS`) de "el usuario escribió texto fijo", y manejar el valor ausente con un mensaje apropiado por campo:

```js
const KNOWN_FIELD_KEYS = new Set(CLIENT_DATA_FIELDS.map(f => f.key));
// ...dentro del forEach de variables:
if (mappedValue && KNOWN_FIELD_KEYS.has(mappedValue)) {
  const value = client ? client[mappedValue] : undefined;
  if (value !== null && value !== undefined && value !== '') {
    replacement = value;
  } else if (mappedValue === 'dias_sin_pedir') {
    replacement = 'Sin historial';
  } else {
    replacement = '—';
  }
} else if (mappedValue) {
  replacement = mappedValue; // texto fijo
}
```

Esto corrige de una sola vez el caso de `campaign_contacts` (`dias_sin_pedir = null` → "Sin historial") y el bug preexistente (cliente real con 0 días → ahora muestra `0` correctamente en vez del nombre del campo). Se aplica en la única función `getPreview()`, que ya alimenta los 3 puntos donde se usa (preview de plantilla en Paso 2, preview en vivo en Paso 3, confirmación en Paso 4) — un solo cambio, tres lugares corregidos.

## 5. Frontend — `Campaigns.jsx`

- **Nueva tarjeta de segmento** junto a las 5 actuales: "Importar lista externa (CSV)", ícono `Upload` de lucide-react.
- Al seleccionarla: en vez de mostrar los filtros de zona/tipo (que no aplican a esta fuente), se muestra un `<input type="file" accept=".csv">`.
- Al elegir un archivo: se lee con `FileReader.readAsText()`, se manda el contenido a `POST /api/campaigns/import-contacts`, con estado de carga mientras se procesa.
- **Éxito:** se muestra el resumen (`importados / ya_cliente / ya_importado / invalidas`), `contacts` pasa a ser el estado `eligibleClients` (el mismo que ya consumen los Pasos 2-5, sin tocarlos), y se guarda un estado nuevo `contactSource = 'campaign_contacts'`. El resto de los segmentos existentes deja `contactSource = 'clients'` (valor por defecto).
- **Falla de archivo completo** (400 del backend, o error de red/lectura del archivo): se muestra en el mismo banner de error rojo que ya usan los otros pasos (`{error && <p className="text-red-500">{error}</p>}`), sin avanzar el wizard ni mostrar un resumen.
- `handleSendCampaign` suma `source: contactSource` al payload de `POST /api/campaigns/send`.
- `resetWizard()` también resetea `contactSource` a `'clients'`.
- **Pasos 2, 3, 4, 5 no cambian su estructura** — siguen operando sobre `eligibleClients` tal cual, salvo el fix de `getPreview()` de la sección 4 (que beneficia a ambas fuentes por igual).

## Pruebas

Backend (`test/`, mismo patrón `node:test` + servidor real contra SQLite temporal que ya usa el resto del proyecto):
- Import: CSV válido con mezcla de filas válidas/inválidas/duplicadas (contra `clients` y contra `campaign_contacts` de una "importación anterior" simulada) → verifica el `summary` exacto y que solo se insertaron las filas correctas.
- Import: reimportar el mismo CSV dos veces → la segunda vez todo cuenta como `ya_importado`, cero inserciones nuevas.
- Import: archivo vacío, headers incorrectos, y solo-header-sin-filas → cada uno responde 400 con el mensaje específico correspondiente.
- Send: `source: 'campaign_contacts'` con contactos importados → verifica que `campaign_logs` guarda `campaign_contact_id` (no `client_id`) y `contact_source` correcto.

Frontend: verificación manual en navegador (no hay framework de test de UI en el proyecto) — subir un CSV real de prueba y confirmar el flujo completo hasta el Paso 4, incluyendo el preview con una plantilla que mapee "Días sin pedir" a un contacto importado (debe mostrar "Sin historial", no `null` ni el nombre del campo).

## Gate final antes del piloto real

Antes de autorizar cualquier envío real a los 40 contactos del piloto, el usuario requiere explícitamente: `node --check` sobre los archivos backend tocados, `npm run build` del cliente, `git status` y `git diff --stat` de todo el módulo de Campañas (import + send + frontend), como última verificación antes de disparar mensajes reales por WhatsApp.
