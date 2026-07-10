import React, { useState, useEffect, useCallback } from 'react';
import { riders as ridersApi, orders as ordersApi, payments as paymentsApi } from '../api.js';
import { getPosition } from '../geo.js';
import { RefreshCw, LogOut, MapPin, Phone, Truck, CheckCircle, XCircle } from 'lucide-react';
import toast from 'react-hot-toast';

// Mapea el método de pago del pedido → método/destinos del módulo de cuadre.
const METHOD_MAP = {
  'Efectivo':       { method: 'efectivo',      dests: [['efectivo_motorizado', 'Efectivo (lo tengo yo)']] },
  'Yape':           { method: 'yape',          dests: [['yape_luis', 'Yape Luis'], ['yape_gisela', 'Yape Gisela']] },
  'Plin':           { method: 'plin',          dests: [['plin_luis', 'Plin Luis'], ['plin_gisela', 'Plin Gisela']] },
  'Transferencias': { method: 'transferencia', dests: [['bcp_lm', 'BCP L&M'], ['bcp_luis', 'BCP Luis'], ['bcp_gisela', 'BCP Gisela'], ['bbva_lm', 'BBVA L&M'], ['otro', 'Otra cuenta']] },
  'T/C':            { method: 'tarjeta',        dests: [['pos_lm', 'POS L&M']] },
};
const NO_DELIVERY_REASONS = ['Cliente ausente', 'Rechazó el pedido', 'Dirección incorrecta', 'No contestó', 'Otro'];

const fmt = (n) => `S/ ${(Number(n) || 0).toFixed(2)}`;
const STATUS_STYLE = {
  'Pendiente':    'bg-gray-100 text-gray-700 dark:bg-gray-700 dark:text-gray-300',
  'En camino':    'bg-blue-100 text-blue-700 dark:bg-blue-900/40 dark:text-blue-300',
  'Entregado':    'bg-green-100 text-green-700 dark:bg-green-900/40 dark:text-green-300',
  'No entregado': 'bg-red-100 text-red-700 dark:bg-red-900/40 dark:text-red-300',
  'Cancelado':    'bg-gray-200 text-gray-500 dark:bg-gray-800 dark:text-gray-500',
};

export default function RiderInbox({ rider, onLogout }) {
  const [orders, setOrders] = useState([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(null);          // id del pedido en proceso
  const [sheet, setSheet] = useState(null);        // { order, mode: 'deliver' | 'fail' }
  const [dest, setDest] = useState('');

  const load = useCallback(async () => {
    setLoading(true);
    try { const data = await ridersApi.inbox(rider.id); setOrders(data.orders || []); }
    catch { toast.error('No se pudieron cargar tus entregas'); }
    finally { setLoading(false); }
  }, [rider.id]);

  useEffect(() => { load(); }, [load]);

  const setEnCamino = async (o) => {
    setBusy(o.id);
    try {
      const geo = await getPosition();
      await ordersApi.updateStatus(o.id, 'En camino', null, geo);
      toast.success('En camino');
      await load();
    }
    catch { toast.error('Error al actualizar'); }
    finally { setBusy(null); }
  };

  const openDeliver = (o) => {
    const m = METHOD_MAP[o.payment_method];
    setDest(m && m.dests.length === 1 ? m.dests[0][0] : '');
    setSheet({ order: o, mode: 'deliver' });
  };
  const openFail = (o) => { setSheet({ order: o, mode: 'fail' }); };

  const cobroInfo = (o) => {
    const isCredit = o.payment_method === 'Crédito';
    const isFree   = Number(o.total) <= 0;
    const alreadyPaid = !!o.payment_status;
    const needsCobro = !isCredit && !isFree && !alreadyPaid;
    return { isCredit, isFree, alreadyPaid, needsCobro, map: METHOD_MAP[o.payment_method] };
  };

  const confirmDeliver = async () => {
    const o = sheet.order;
    const { needsCobro, map } = cobroInfo(o);
    if (needsCobro && map && map.dests.length > 1 && !dest) { toast.error('Elige a dónde se cobró'); return; }
    setBusy(o.id);
    try {
      const geo = await getPosition();
      if (needsCobro && map) {
        await paymentsApi.create(o.id, {
          amount: o.total,
          method: map.method,
          destination: dest || map.dests[0][0],
          reported_by: rider.name,
        });
      }
      await ordersApi.updateStatus(o.id, 'Entregado', null, geo);
      toast.success('Pedido entregado ✅');
      setSheet(null); await load();
    } catch (e) {
      toast.error(e?.response?.data?.error || 'Error al registrar la entrega');
    } finally { setBusy(null); }
  };

  const confirmFail = async (reasonArg) => {
    const o = sheet.order;
    if (!reasonArg) { toast.error('Indica el motivo'); return; }
    setBusy(o.id);
    try {
      const geo = await getPosition();
      await ordersApi.updateStatus(o.id, 'No entregado', reasonArg, geo);
      toast.success('Marcado como no entregado');
      setSheet(null); await load();
    } catch { toast.error('Error al actualizar'); }
    finally { setBusy(null); }
  };

  return (
    <div className="min-h-screen bg-gray-50 dark:bg-gray-900 flex flex-col">
      {/* Top bar */}
      <header className="sticky top-0 z-40 bg-blue-900 dark:bg-blue-950 text-white shadow-lg">
        <div className="max-w-2xl mx-auto px-4 h-14 flex items-center justify-between">
          <div className="flex items-center gap-2">
            <Truck size={20} />
            <div className="leading-tight">
              <p className="text-sm font-bold">{rider.name}</p>
              <p className="text-[11px] text-blue-200">Mis entregas de hoy</p>
            </div>
          </div>
          <div className="flex items-center gap-1">
            <button onClick={load} className="p-2 rounded-lg active:bg-blue-800" aria-label="Actualizar"><RefreshCw size={18} /></button>
            <button onClick={onLogout} className="p-2 rounded-lg active:bg-blue-800" aria-label="Salir"><LogOut size={18} /></button>
          </div>
        </div>
      </header>

      <main className="flex-1 max-w-2xl mx-auto w-full p-4 space-y-3">
        {loading ? (
          <div className="flex items-center justify-center h-64"><div className="animate-spin text-4xl">🛵</div></div>
        ) : orders.length === 0 ? (
          <div className="card p-8 text-center text-gray-400">
            <Truck size={40} className="mx-auto mb-3 opacity-40" />
            No tienes entregas asignadas para hoy.
          </div>
        ) : orders.map(o => {
          const { isCredit, isFree, alreadyPaid } = cobroInfo(o);
          const active = o.status === 'Pendiente' || o.status === 'En camino';
          return (
            <div key={o.id} className="card p-4 space-y-3">
              {/* Header: cliente + estado */}
              <div className="flex items-start justify-between gap-2">
                <div className="min-w-0">
                  <p className="font-bold text-gray-900 dark:text-white truncate">{o.client_name || 'Cliente'}</p>
                  {o.client_address && (
                    <p className="text-sm text-gray-500 dark:text-gray-400 flex items-start gap-1 mt-0.5">
                      <MapPin size={14} className="mt-0.5 shrink-0" /> {o.client_address}
                    </p>
                  )}
                </div>
                <span className={`text-xs px-2 py-1 rounded-full font-medium shrink-0 ${STATUS_STYLE[o.status] || ''}`}>{o.status}</span>
              </div>

              {/* Productos */}
              {o.items?.length > 0 && (
                <div className="text-sm text-gray-700 dark:text-gray-300 bg-gray-50 dark:bg-gray-700/40 rounded-lg p-2">
                  {o.items.map((i, idx) => (
                    <div key={idx} className="flex justify-between">
                      <span>{i.quantity}× {i.name}{i.category === 'regalo' ? ' 🎁' : ''}</span>
                    </div>
                  ))}
                </div>
              )}

              {/* Pago */}
              <div className="flex items-center justify-between text-sm">
                <span className="text-gray-500">Forma de pago</span>
                <span className="font-semibold text-gray-800 dark:text-gray-200">{o.payment_method}</span>
              </div>
              <div className="flex items-center justify-between">
                <span className="text-gray-500 text-sm">{isCredit ? 'Va a deuda' : 'A cobrar'}</span>
                <span className={`text-xl font-bold ${isCredit ? 'text-red-500' : 'text-orange-500'}`}>
                  {isFree ? 'Gratis' : fmt(o.total)}
                </span>
              </div>
              {isCredit && <p className="text-xs text-red-500">⚠ A crédito: NO cobres, se suma a la deuda del cliente.</p>}
              {alreadyPaid && <p className="text-xs text-green-600">✓ Pago ya registrado</p>}
              {o.phone_normalized || o.client_phone ? (
                <a href={`tel:${o.client_phone}`} className="text-xs text-blue-600 flex items-center gap-1"><Phone size={12} /> {o.client_phone}</a>
              ) : null}

              {/* No entregado: motivo */}
              {o.status === 'No entregado' && o.non_delivery_reason && (
                <p className="text-xs text-red-500">Motivo: {o.non_delivery_reason}</p>
              )}

              {/* Acciones */}
              {o.status === 'Pendiente' && (
                <button disabled={busy === o.id} onClick={() => setEnCamino(o)}
                  className="w-full py-3 rounded-xl bg-blue-900 text-white font-bold active:bg-blue-950 disabled:opacity-50">
                  🛵 Marcar En camino
                </button>
              )}
              {o.status === 'En camino' && (
                <div className="grid grid-cols-2 gap-2">
                  <button disabled={busy === o.id} onClick={() => openDeliver(o)}
                    className="py-3 rounded-xl bg-green-600 text-white font-bold active:bg-green-700 disabled:opacity-50 flex items-center justify-center gap-1">
                    <CheckCircle size={18} /> Entregado
                  </button>
                  <button disabled={busy === o.id} onClick={() => openFail(o)}
                    className="py-3 rounded-xl bg-red-500 text-white font-bold active:bg-red-600 disabled:opacity-50 flex items-center justify-center gap-1">
                    <XCircle size={18} /> No entregado
                  </button>
                </div>
              )}
            </div>
          );
        })}
        <div className="h-4" />
      </main>

      {/* Bottom sheet: entrega/cobro o motivo */}
      {sheet && (
        <div className="fixed inset-0 z-50 flex items-end justify-center bg-black/40" onClick={() => busy ? null : setSheet(null)}>
          <div className="w-full max-w-2xl bg-white dark:bg-gray-800 rounded-t-2xl p-5 space-y-4" onClick={e => e.stopPropagation()}>
            <div className="w-10 h-1 bg-gray-300 rounded-full mx-auto" />
            {sheet.mode === 'deliver' ? (
              <DeliverSheet order={sheet.order} info={cobroInfo(sheet.order)} dest={dest} setDest={setDest}
                busy={busy === sheet.order.id} onCancel={() => setSheet(null)} onConfirm={confirmDeliver} />
            ) : (
              <FailSheet order={sheet.order}
                busy={busy === sheet.order.id} onCancel={() => setSheet(null)} onConfirm={confirmFail} />
            )}
          </div>
        </div>
      )}
    </div>
  );
}

function DeliverSheet({ order, info, dest, setDest, busy, onCancel, onConfirm }) {
  const { isCredit, isFree, needsCobro, map } = info;
  return (
    <>
      <h3 className="text-lg font-bold text-gray-900 dark:text-white text-center">Confirmar entrega</h3>
      <p className="text-center text-sm text-gray-500">{order.client_name}</p>

      {isCredit ? (
        <div className="bg-red-50 dark:bg-red-900/20 rounded-xl p-3 text-sm text-red-600 dark:text-red-400">
          A crédito: <strong>no cobres nada</strong>. Se sumará {`S/ ${(Number(order.total) || 0).toFixed(2)}`} a la deuda del cliente.
        </div>
      ) : isFree ? (
        <div className="bg-gray-50 dark:bg-gray-700/40 rounded-xl p-3 text-sm text-gray-600 dark:text-gray-300 text-center">Sin cobro (S/ 0).</div>
      ) : needsCobro ? (
        <div className="space-y-3">
          <div className="bg-orange-50 dark:bg-orange-900/20 rounded-xl p-3 text-center">
            <p className="text-xs text-gray-500">Cobra por {order.payment_method}</p>
            <p className="text-2xl font-bold text-orange-500">{`S/ ${(Number(order.total) || 0).toFixed(2)}`}</p>
          </div>
          {map && map.dests.length > 1 && (
            <div>
              <label className="text-sm font-medium text-gray-700 dark:text-gray-300">¿A qué cuenta se pagó?</label>
              <select value={dest} onChange={e => setDest(e.target.value)} className="w-full mt-1 p-3 border rounded-xl dark:bg-gray-700 dark:border-gray-600">
                <option value="">— Elige —</option>
                {map.dests.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
              </select>
            </div>
          )}
          {map && map.method !== 'efectivo' && (
            <p className="text-xs text-gray-400">El admin confirmará este pago en el cuadre de caja.</p>
          )}
        </div>
      ) : (
        <div className="bg-green-50 dark:bg-green-900/20 rounded-xl p-3 text-sm text-green-600 text-center">El pago ya estaba registrado.</div>
      )}

      <div className="flex gap-2 pt-1">
        <button onClick={onCancel} disabled={busy} className="flex-1 py-3 rounded-xl bg-gray-200 dark:bg-gray-700 text-gray-700 dark:text-gray-200 font-medium disabled:opacity-50">Cancelar</button>
        <button onClick={onConfirm} disabled={busy} className="flex-1 py-3 rounded-xl bg-green-600 text-white font-bold active:bg-green-700 disabled:opacity-50">
          {busy ? 'Guardando…' : 'Confirmar entrega'}
        </button>
      </div>
    </>
  );
}

function FailSheet({ order, busy, onCancel, onConfirm }) {
  const [choice, setChoice] = useState('');
  const [custom, setCustom] = useState('');
  const finalReason = choice === 'Otro' ? custom.trim() : choice;
  return (
    <>
      <h3 className="text-lg font-bold text-gray-900 dark:text-white text-center">¿Por qué no se entregó?</h3>
      <p className="text-center text-sm text-gray-500">{order.client_name}</p>
      <div className="grid grid-cols-2 gap-2">
        {NO_DELIVERY_REASONS.map(r => (
          <button key={r} onClick={() => setChoice(r)}
            className={`py-2.5 rounded-xl text-sm font-medium border ${choice === r ? 'bg-red-500 text-white border-red-500' : 'bg-gray-100 dark:bg-gray-700 text-gray-700 dark:text-gray-300 border-transparent'}`}>
            {r}
          </button>
        ))}
      </div>
      {choice === 'Otro' && (
        <input autoFocus value={custom} onChange={e => setCustom(e.target.value)}
          placeholder="Escribe el motivo…" className="w-full p-3 border rounded-xl dark:bg-gray-700 dark:border-gray-600" />
      )}
      <div className="flex gap-2 pt-1">
        <button onClick={onCancel} disabled={busy} className="flex-1 py-3 rounded-xl bg-gray-200 dark:bg-gray-700 text-gray-700 dark:text-gray-200 font-medium disabled:opacity-50">Cancelar</button>
        <button onClick={() => onConfirm(finalReason)} disabled={busy || !finalReason} className="flex-1 py-3 rounded-xl bg-red-500 text-white font-bold active:bg-red-600 disabled:opacity-50">
          {busy ? 'Guardando…' : 'Confirmar'}
        </button>
      </div>
    </>
  );
}
