import React, { useState } from 'react';
import { Document, Page, View, Text, StyleSheet, Svg, Rect, Line, pdf } from '@react-pdf/renderer';
import toast from 'react-hot-toast';
import { clients as clientsApi, config as configApi } from '../api.js';

const ACCENT = '#f97316';
const NAVY = '#1e3a8a';
const TEAL = '#0d9488';
const TEXT = '#1a1a1a';
const MUTED = '#6b6b6b';
const BORDER = '#e5e2dc';
const BG_SOFT = '#faf9f7';

// Un color por tipo de balón para diferenciar las barras del gráfico combinado.
const TYPE_COLORS = { '10kg Normal': ACCENT, '10kg Premium': NAVY, '45kg': TEAL };

// El gráfico solo muestra las últimas N recompras por tipo para no saturarse;
// la tabla de arriba sí lista el historial completo.
const MAX_BARS_PER_TYPE = 12;

const styles = StyleSheet.create({
  page: { padding: 32, fontSize: 10, color: TEXT, fontFamily: 'Helvetica' },
  header: {
    flexDirection: 'row', justifyContent: 'space-between', alignItems: 'flex-start',
    borderBottomWidth: 2, borderBottomColor: ACCENT, paddingBottom: 12, marginBottom: 16,
  },
  brandName: { fontSize: 16, fontWeight: 'bold' },
  brandSubtitle: { fontSize: 11, color: ACCENT, marginTop: 2 },
  emittedDate: { fontSize: 9, color: MUTED },
  clientBox: { backgroundColor: BG_SOFT, borderRadius: 4, padding: 10, marginBottom: 16 },
  clientLine: { fontSize: 10, marginBottom: 4 },
  clientRow: { flexDirection: 'row', gap: 24 },
  muted: { color: MUTED },
  sectionTitle: { fontSize: 11, fontWeight: 'bold', marginBottom: 8 },
  table: { marginBottom: 18 },
  tableHeaderRow: {
    flexDirection: 'row', gap: 6, borderBottomWidth: 1, borderBottomColor: BORDER, paddingBottom: 5, marginBottom: 2,
  },
  tableRow: {
    flexDirection: 'row', gap: 6, borderBottomWidth: 0.5, borderBottomColor: BORDER, paddingVertical: 5,
  },
  th: { fontSize: 8.5, color: MUTED, fontWeight: 'bold' },
  td: { fontSize: 9 },
  colDate:  { width: '16%' },
  colType:  { width: '17%' },
  colBrand: { width: '15%' },
  colQty:   { width: '10%' },
  colPrice: { width: '17%' },
  colRider: { width: '18%' },
  tCenter: { textAlign: 'center' },
  tRight:  { textAlign: 'right' },
  mutedNote: { fontSize: 9, color: MUTED, marginBottom: 16 },
  chartSection: { marginBottom: 18 },
  chartHeaderRow: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginBottom: 6 },
  legendRow: { flexDirection: 'row', gap: 12 },
  legendItem: { flexDirection: 'row', alignItems: 'center', gap: 4 },
  legendSwatch: { width: 7, height: 7, borderRadius: 1 },
  legendLabel: { fontSize: 8, color: MUTED },
  footer: {
    position: 'absolute', bottom: 24, left: 32, right: 32,
    borderTopWidth: 0.5, borderTopColor: BORDER, paddingTop: 8,
  },
  footerText: { fontSize: 8, color: MUTED, textAlign: 'center' },
});

function orDash(v) {
  return v === null || v === undefined || v === '' ? '—' : String(v);
}

function fmtMoney(n) {
  const num = Number(n);
  if (n === null || n === undefined || Number.isNaN(num)) return '—';
  return `S/ ${num.toFixed(2)}`;
}

function fmtDateFull(iso) {
  if (!iso) return '—';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '—';
  const dd = String(d.getDate()).padStart(2, '0');
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  return `${dd}/${mm}/${d.getFullYear()}`;
}

function fmtDateShort(iso) {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '—';
  return `${String(d.getDate()).padStart(2, '0')}/${String(d.getMonth() + 1).padStart(2, '0')}`;
}

// Reordena la lista de teléfonos del negocio (string "a / b / c") poniendo
// primero el número de contacto preferido para pedidos, sin tocar el dato
// guardado en /api/config (que también usa la nota de pedido individual).
function reorderPhones(phonesStr) {
  const PRIORITY = '998275775';
  const parts = String(phonesStr || '').split('/').map(s => s.trim()).filter(Boolean);
  parts.sort((a, b) => {
    const aFirst = a.replace(/\D/g, '').includes(PRIORITY) ? 0 : 1;
    const bFirst = b.replace(/\D/g, '').includes(PRIORITY) ? 0 : 1;
    return aFirst - bFirst;
  });
  return parts.join(' / ');
}

// Agrupa por tipo de balón las filas que ya tienen dias_duracion (a partir de
// la 2ª compra de ese tipo), recorta a las últimas MAX_BARS_PER_TYPE por tipo
// y devuelve todo mezclado en orden cronológico para el gráfico combinado.
function selectChartBars(history) {
  const byType = {};
  for (const h of history) {
    if (h.dias_duracion == null) continue;
    (byType[h.type] ||= []).push(h);
  }
  let truncated = false;
  const bars = [];
  for (const list of Object.values(byType)) {
    let picked = list;
    if (picked.length > MAX_BARS_PER_TYPE) {
      picked = picked.slice(picked.length - MAX_BARS_PER_TYPE);
      truncated = true;
    }
    bars.push(...picked);
  }
  bars.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
  return { bars, types: Object.keys(byType), truncated };
}

// Escala del eje Y: 0-60 días por defecto, en marcas de 10. Si algún valor
// real supera 60, el eje se expande (siempre múltiplo de 10) para no cortar
// nunca una barra.
const DEFAULT_AXIS_MAX = 60;
const AXIS_STEP = 10;

function DurationChart({ history }) {
  const { bars, types, truncated } = selectChartBars(history);
  if (!bars.length) return null;

  const width = 531; // ancho útil de página A4 (595 - 2*32 de padding)
  const leftMargin = 22; // espacio para las etiquetas del eje Y
  const plotWidth = width - leftMargin;
  const chartHeight = 92;
  const baseline = 68;
  const maxBarHeight = 58;

  const maxDays = Math.max(0, ...bars.map(b => b.dias_duracion));
  const axisMax = Math.max(DEFAULT_AXIS_MAX, Math.ceil(maxDays / AXIS_STEP) * AXIS_STEP);
  const ticks = [];
  for (let v = 0; v <= axisMax; v += AXIS_STEP) ticks.push(v);
  const tickY = (v) => baseline - (v / axisMax) * maxBarHeight;

  const slot = plotWidth / bars.length;
  const barWidth = Math.max(6, Math.min(26, slot * 0.55));

  return (
    <View style={styles.chartSection} wrap={false}>
      <View style={styles.chartHeaderRow}>
        <Text style={styles.sectionTitle}>Días de duración entre compras</Text>
        {types.length > 1 && (
          <View style={styles.legendRow}>
            {types.map(t => (
              <View key={t} style={styles.legendItem}>
                <View style={[styles.legendSwatch, { backgroundColor: TYPE_COLORS[t] || ACCENT }]} />
                <Text style={styles.legendLabel}>{t}</Text>
              </View>
            ))}
          </View>
        )}
      </View>
      {truncated && (
        <Text style={styles.mutedNote}>Mostrando las últimas {MAX_BARS_PER_TYPE} recompras por tipo.</Text>
      )}
      <Svg width={width} height={chartHeight}>
        {ticks.map(v => (
          <React.Fragment key={`tick-${v}`}>
            <Line
              x1={leftMargin} x2={width} y1={tickY(v)} y2={tickY(v)}
              stroke={v === 0 ? MUTED : BORDER} strokeWidth={v === 0 ? 0.75 : 0.5}
            />
            <Text x={leftMargin - 4} y={tickY(v) + 2} textAnchor="end" style={{ fontSize: 6, fill: MUTED }}>
              {v}
            </Text>
          </React.Fragment>
        ))}
        <Line x1={leftMargin} x2={leftMargin} y1={tickY(axisMax)} y2={baseline} stroke={MUTED} strokeWidth={0.75} />
        {bars.map((b, i) => {
          const x = leftMargin + i * slot + (slot - barWidth) / 2;
          const h = Math.max(3, (b.dias_duracion / axisMax) * maxBarHeight);
          const y = baseline - h;
          const color = TYPE_COLORS[b.type] || ACCENT;
          return (
            <React.Fragment key={`${b.order_id}-${b.date}-${i}`}>
              <Text x={x + barWidth / 2} y={y - 4} textAnchor="middle" style={{ fontSize: 7, fill: MUTED }}>
                {b.dias_duracion}
              </Text>
              <Rect x={x} y={y} width={barWidth} height={h} fill={color} rx={2} />
              <Text x={x + barWidth / 2} y={baseline + 11} textAnchor="middle" style={{ fontSize: 6, fill: MUTED }}>
                {fmtDateShort(b.date)}
              </Text>
            </React.Fragment>
          );
        })}
      </Svg>
    </View>
  );
}

function HistoryTable({ history }) {
  return (
    <View style={styles.table}>
      <View style={styles.tableHeaderRow}>
        <Text style={[styles.th, styles.colDate]}>Fecha</Text>
        <Text style={[styles.th, styles.colType]}>Balón</Text>
        <Text style={[styles.th, styles.colBrand]}>Marca</Text>
        <Text style={[styles.th, styles.colQty, styles.tCenter]}>Cant.</Text>
        <Text style={[styles.th, styles.colPrice, styles.tRight]}>Precio</Text>
        <Text style={[styles.th, styles.colRider]}>Motorizado</Text>
      </View>
      {history.map((h, i) => (
        <View key={`${h.order_id}-${h.date}-${i}`} style={styles.tableRow} wrap={false}>
          <Text style={[styles.td, styles.colDate]}>{fmtDateFull(h.date)}</Text>
          <Text style={[styles.td, styles.colType]}>{h.type}</Text>
          <Text style={[styles.td, styles.colBrand]}>{orDash(h.brand)}</Text>
          <Text style={[styles.td, styles.colQty, styles.tCenter]}>{h.quantity ?? '—'}</Text>
          <Text style={[styles.td, styles.colPrice, styles.tRight]}>{fmtMoney(h.price)}</Text>
          <Text style={[styles.td, styles.colRider]}>{orDash(h.rider_name)}</Text>
        </View>
      ))}
    </View>
  );
}

export function PurchaseHistoryDocument({ client, company, history }) {
  const hasAnyDuration = history.some(h => h.dias_duracion != null);
  return (
    <Document>
      <Page size="A4" style={styles.page}>
        <View style={styles.header}>
          <View>
            <Text style={styles.brandName}>L&M Distribuidora de Gas</Text>
            <Text style={styles.brandSubtitle}>Recibo histórico de compras</Text>
          </View>
          <Text style={styles.emittedDate}>Emitido: {fmtDateFull(new Date().toISOString())}</Text>
        </View>

        <View style={styles.clientBox}>
          <Text style={styles.clientLine}><Text style={styles.muted}>Cliente: </Text>{client.name}</Text>
          <View style={styles.clientRow}>
            <Text style={styles.clientLine}><Text style={styles.muted}>Dirección: </Text>{orDash(client.address)}</Text>
            <Text style={styles.clientLine}><Text style={styles.muted}>Teléfono: </Text>{orDash(client.phone)}</Text>
          </View>
        </View>

        <Text style={styles.sectionTitle}>Historial de pedidos</Text>
        <HistoryTable history={history} />

        {!hasAnyDuration ? (
          <Text style={styles.mutedNote}>
            A partir de tu próxima compra te mostraremos cuánto te dura el balón.
          </Text>
        ) : (
          <DurationChart history={history} />
        )}

        <View style={styles.footer} fixed>
          <Text style={styles.footerText}>Pedidos: {reorderPhones(company?.company_phones)}</Text>
          <Text style={styles.footerText}>Gracias por confiar en L&M Distribuidora de Gas — siempre a tu servicio.</Text>
        </View>
      </Page>
    </Document>
  );
}

function kebabCase(str) {
  return String(str || 'cliente')
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '') || 'cliente';
}

function todayKebabDate() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

/**
 * Botón "Generar recibo PDF": llama al endpoint de historial, arma el PDF con
 * @react-pdf/renderer en el cliente y lo descarga.
 */
export default function GenerateReceiptButton({ clientId, clientName, className }) {
  const [busy, setBusy] = useState(false);

  const generate = async () => {
    setBusy(true);
    try {
      const [historyData, company] = await Promise.all([
        clientsApi.purchaseHistory(clientId),
        configApi.get(),
      ]);
      if (!historyData.history?.length) {
        toast.error('Este cliente todavía no tiene compras de balones registradas');
        return;
      }
      const blob = await pdf(
        <PurchaseHistoryDocument client={historyData.client} company={company} history={historyData.history} />
      ).toBlob();

      const filename = `recibo-lm-${kebabCase(clientName)}-${todayKebabDate()}.pdf`;
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url; a.download = filename;
      document.body.appendChild(a); a.click(); a.remove();
      URL.revokeObjectURL(url);
    } catch (e) {
      toast.error('No se pudo generar el recibo. Intenta de nuevo.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <button onClick={generate} disabled={busy} className={className}>
      {busy ? 'Generando recibo…' : 'Generar recibo PDF'}
    </button>
  );
}
