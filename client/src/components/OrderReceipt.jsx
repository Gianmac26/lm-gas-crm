import React, { useRef, useState } from 'react';
import html2canvas from 'html2canvas';
import toast from 'react-hot-toast';

const fmt = (n) => `S/ ${(Number(n) || 0).toFixed(2)}`;
function fmtDate(s) {
  if (!s) return '';
  return new Date(s).toLocaleString('es-PE', { dateStyle: 'medium', timeStyle: 'short' });
}
const isGift = (i) => i.category === 'regalo';
function unitPrice(i) {
  if (i.unit_price != null) return Number(i.unit_price);
  if (i.subtotal != null && i.quantity) return Number(i.subtotal) / Number(i.quantity);
  return 0;
}

/**
 * Botón que genera la Nota de pedido como imagen (PNG) y la comparte por
 * WhatsApp. El ticket se renderiza fuera de pantalla (no visible) solo para
 * que html2canvas lo capture; nunca aparece en el layout normal.
 */
export default function ReceiptButton({ order, company, className }) {
  const ref = useRef(null);
  const [busy, setBusy] = useState(false);
  const items = order.items || [];

  const generate = async () => {
    setBusy(true);
    try {
      const canvas = await html2canvas(ref.current, { backgroundColor: '#ffffff', scale: 2 });
      const blob = await new Promise((resolve) => canvas.toBlob(resolve, 'image/png'));
      if (!blob) throw new Error('sin blob');
      const file = new File([blob], `nota-pedido-${order.id}.png`, { type: 'image/png' });

      if (navigator.canShare && navigator.canShare({ files: [file] })) {
        await navigator.share({ files: [file], title: `Nota de pedido #${order.id}` });
      } else {
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url; a.download = file.name;
        document.body.appendChild(a); a.click(); a.remove();
        URL.revokeObjectURL(url);
        toast('Imagen descargada. Adjúntala en WhatsApp.', { icon: '🧾' });
      }
    } catch (e) {
      if (e?.name !== 'AbortError') toast.error('No se pudo generar la nota');
    } finally { setBusy(false); }
  };

  return (
    <>
      <button onClick={generate} disabled={busy} className={className}>
        {busy ? 'Generando…' : '🧾 Emitir nota'}
      </button>

      {/* Ticket fuera de pantalla: html2canvas necesita que esté en el DOM con
          layout real, por eso "left: -9999px" en vez de display:none. */}
      <div ref={ref} style={{
        position: 'fixed', top: 0, left: -9999, width: 380, padding: 20,
        background: '#fff', color: '#111', fontFamily: 'Arial, Helvetica, sans-serif', fontSize: 13,
      }}>
        <div style={{ textAlign: 'center', marginBottom: 10 }}>
          <div style={{ fontWeight: 'bold', fontSize: 16 }}>{company.company_name || 'L&M Gas'}</div>
          {company.company_ruc && <div>RUC: {company.company_ruc}</div>}
          {company.company_address && <div>{company.company_address}</div>}
          {company.company_phones && <div>{company.company_phones}</div>}
        </div>
        <div style={{ borderTop: '1px dashed #999', margin: '8px 0' }} />
        <div>Pedido #{order.id} — {fmtDate(order.created_at)}</div>
        <div>Cliente: {order.client_name || '—'}</div>
        {order.client_address && <div>Dirección: {order.client_address}</div>}
        {order.client_phone && <div>Teléfono: {order.client_phone}</div>}
        <div style={{ borderTop: '1px dashed #999', margin: '8px 0' }} />
        <table style={{ width: '100%', borderCollapse: 'collapse' }}>
          <thead>
            <tr>
              <td style={{ fontWeight: 'bold', paddingBottom: 4 }}>Producto</td>
              <td style={{ fontWeight: 'bold', textAlign: 'center', paddingBottom: 4 }}>Cant.</td>
              <td style={{ fontWeight: 'bold', textAlign: 'right', paddingBottom: 4 }}>Precio</td>
            </tr>
          </thead>
          <tbody>
            {items.map((it, i) => (
              <tr key={i}>
                <td>{it.name}{isGift(it) ? ' (Regalo)' : ''}</td>
                <td style={{ textAlign: 'center' }}>{it.quantity}</td>
                <td style={{ textAlign: 'right' }}>{isGift(it) ? 'S/ 0.00' : fmt(unitPrice(it))}</td>
              </tr>
            ))}
          </tbody>
        </table>
        <div style={{ borderTop: '1px dashed #999', margin: '8px 0' }} />
        <div style={{ display: 'flex', justifyContent: 'space-between', fontWeight: 'bold', fontSize: 15 }}>
          <span>Total</span><span>{fmt(order.total)}</span>
        </div>
        <div>Forma de pago: {order.payment_method}</div>
        <div style={{ textAlign: 'center', marginTop: 12, fontSize: 11, color: '#666' }}>¡Gracias por su preferencia!</div>
      </div>
    </>
  );
}
