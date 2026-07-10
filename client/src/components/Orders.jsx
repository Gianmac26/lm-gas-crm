import React, { useState, useEffect, useCallback } from 'react';
import { useNavigate } from 'react-router-dom';
import { orders as ordersApi, riders } from '../api.js';
import { Plus, ChevronRight, RefreshCw } from 'lucide-react';
import toast from 'react-hot-toast';

const STATUSES = ['Todos', 'Pendiente', 'En camino', 'Entregado', 'Cancelado'];

const STATUS_COLORS = {
  'Pendiente':  { dot: 'bg-yellow-400', badge: 'badge-pending' },
  'En camino':  { dot: 'bg-blue-500',   badge: 'badge-transit' },
  'Entregado':  { dot: 'bg-green-500',  badge: 'badge-delivered' },
  'Cancelado':  { dot: 'bg-red-400',    badge: 'badge-cancelled' },
};

const NEXT_STATUS = {
  'Pendiente': 'En camino',
  'En camino': 'Entregado',
};

// Umbral de negocio: más de esto entre "En camino" y el cierre se marca para revisar.
const SLOW_DELIVERY_MINUTES = 20;
// Bajo este radio de error (metros) el GPS se considera confiable.
const HIGH_ACCURACY_METERS = 50;

function fmt(n) { return `S/ ${(n||0).toFixed(0)}`; }
function fmtTime(s) {
  if (!s) return '';
  return new Date(s).toLocaleTimeString('es-PE', { hour: '2-digit', minute: '2-digit' });
}

// Minutos entre la salida y el cierre. `null` si el pedido nunca pasó por
// "En camino" (p. ej. lo cerró el admin directo), así no inventa alertas.
function elapsedMinutes(o) {
  if (!o.departed_at || !o.closed_at) return null;
  const ms = new Date(o.closed_at) - new Date(o.departed_at);
  if (!Number.isFinite(ms) || ms < 0) return null;
  return Math.round(ms / 60000);
}

const hasClosingPoint = (o) => o.closed_lat != null && o.closed_lng != null;

export default function Orders() {
  const [list, setList] = useState([]);
  const [riderList, setRiderList] = useState([]);
  const [filterStatus, setFilterStatus] = useState('');
  const [filterRider, setFilterRider] = useState('');
  const [date, setDate] = useState(new Date().toISOString().slice(0,10));
  const [loading, setLoading] = useState(true);
  const nav = useNavigate();

  useEffect(() => { riders.list().then(setRiderList); }, []);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const params = { date };
      if (filterStatus && filterStatus !== 'Todos') params.status = filterStatus;
      if (filterRider) params.rider_id = filterRider;
      setList(await ordersApi.list(params));
    } finally { setLoading(false); }
  }, [date, filterStatus, filterRider]);

  useEffect(() => { load(); }, [load]);

  const quickStatus = async (e, orderId, next) => {
    e.stopPropagation();
    try {
      await ordersApi.updateStatus(orderId, next);
      toast.success(`Pedido → ${next}`);
      load();
    } catch { toast.error('Error al actualizar'); }
  };

  const pending  = list.filter(o => o.status === 'Pendiente').length;
  const transit  = list.filter(o => o.status === 'En camino').length;
  const done     = list.filter(o => o.status === 'Entregado').length;
  const revenue  = list.filter(o => o.status === 'Entregado').reduce((s, o) => s + (o.total||0), 0);

  return (
    <div className="p-4 space-y-3">
      {/* Date selector */}
      <div className="flex gap-2 items-center">
        <input
          type="date"
          className="input flex-1 !py-2.5"
          value={date}
          onChange={e => setDate(e.target.value)}
        />
        <button onClick={load} className="btn-ghost !py-2.5 !px-3">
          <RefreshCw size={16} />
        </button>
        <button onClick={() => nav('/orders/new')} className="btn-primary !py-2.5 !px-4 flex items-center gap-1.5 text-sm">
          <Plus size={16} /> Nuevo
        </button>
      </div>

      {/* Summary chips */}
      <div className="flex gap-2 overflow-x-auto no-scrollbar">
        <div className="flex-shrink-0 bg-yellow-50 dark:bg-yellow-900/20 rounded-xl px-3 py-2 text-center min-w-[72px]">
          <div className="text-xl font-bold text-yellow-600">{pending}</div>
          <div className="text-xs text-yellow-600">Pendiente</div>
        </div>
        <div className="flex-shrink-0 bg-blue-50 dark:bg-blue-900/20 rounded-xl px-3 py-2 text-center min-w-[72px]">
          <div className="text-xl font-bold text-blue-600">{transit}</div>
          <div className="text-xs text-blue-600">En camino</div>
        </div>
        <div className="flex-shrink-0 bg-green-50 dark:bg-green-900/20 rounded-xl px-3 py-2 text-center min-w-[72px]">
          <div className="text-xl font-bold text-green-600">{done}</div>
          <div className="text-xs text-green-600">Entregados</div>
        </div>
        <div className="flex-shrink-0 bg-orange-50 dark:bg-orange-900/20 rounded-xl px-3 py-2 text-center min-w-[88px]">
          <div className="text-xl font-bold text-orange-600">{fmt(revenue)}</div>
          <div className="text-xs text-orange-600">Cobrado</div>
        </div>
      </div>

      {/* Filters */}
      <div className="flex gap-2 overflow-x-auto no-scrollbar pb-1">
        {STATUSES.map(s => (
          <button key={s}
            onClick={() => setFilterStatus(s === 'Todos' ? '' : s)}
            className={`flex-shrink-0 px-3 py-1.5 rounded-full text-sm font-medium transition-colors
              ${(filterStatus === s || (!filterStatus && s === 'Todos'))
                ? 'bg-blue-900 text-white' : 'bg-gray-100 dark:bg-gray-800 text-gray-500 dark:text-gray-400'}`}>
            {s}
          </button>
        ))}
        {riderList.length > 0 && (
          <>
            <div className="w-px bg-gray-200 dark:bg-gray-700 mx-1" />
            <button onClick={() => setFilterRider('')}
              className={`flex-shrink-0 px-3 py-1.5 rounded-full text-sm font-medium transition-colors
                ${!filterRider ? 'bg-orange-500 text-white' : 'bg-gray-100 dark:bg-gray-800 text-gray-500'}`}>
              Todos
            </button>
            {riderList.map(r => (
              <button key={r.id} onClick={() => setFilterRider(r.id)}
                className={`flex-shrink-0 px-3 py-1.5 rounded-full text-sm font-medium transition-colors
                  ${filterRider === r.id ? 'bg-orange-500 text-white' : 'bg-gray-100 dark:bg-gray-800 text-gray-500'}`}>
                {r.name.split(' ')[0]}
              </button>
            ))}
          </>
        )}
      </div>

      {/* Order list */}
      {loading ? (
        <div className="space-y-2">
          {[1,2,3].map(i => <div key={i} className="card h-24 animate-pulse bg-gray-100 dark:bg-gray-800" />)}
        </div>
      ) : list.length === 0 ? (
        <div className="card p-8 text-center text-gray-400">
          <div className="text-4xl mb-2">📦</div>
          <p>No hay pedidos para este filtro</p>
        </div>
      ) : (
        <div className="space-y-2">
          {list.map(o => {
            const sc = STATUS_COLORS[o.status] || {};
            const next = NEXT_STATUS[o.status];
            const mins = elapsedMinutes(o);
            const slow = mins !== null && mins > SLOW_DELIVERY_MINUTES;
            const accurate = o.closed_accuracy != null && o.closed_accuracy < HIGH_ACCURACY_METERS;
            return (
              <div key={o.id}
                onClick={() => nav(`/orders/${o.id}/edit`)}
                className={`card p-4 cursor-pointer active:scale-[0.98] transition-transform
                  ${slow ? 'border-2 border-amber-400 dark:border-amber-500' : ''}`}>
                <div className="flex items-start gap-3">
                  <div className={`w-3 h-3 rounded-full mt-1.5 flex-shrink-0 ${sc.dot || 'bg-gray-300'}`} />
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center justify-between">
                      <span className="font-semibold text-gray-900 dark:text-white truncate mr-2">
                        {o.client_name || 'Cliente desconocido'}
                      </span>
                      <span className="font-bold text-gray-900 dark:text-white flex-shrink-0">{fmt(o.total)}</span>
                    </div>
                    <div className="text-xs text-gray-400 mt-0.5 truncate">{o.client_address}</div>
                    <div className="flex items-center gap-3 mt-2 flex-wrap">
                      <span className={`text-xs px-2 py-0.5 rounded-full font-medium ${sc.badge || ''}`}>
                        {o.status}
                      </span>
                      <span className="text-xs text-gray-400">{o.rider_name || 'Sin motorizado'}</span>
                      <span className="text-xs text-gray-400">{fmtTime(o.created_at)}</span>
                      <span className="text-xs text-gray-400">{o.payment_method}</span>
                      {o.client_debt > 50 && (
                        <span className="text-xs text-red-500 font-semibold">⚠ Deuda S/{o.client_debt}</span>
                      )}

                      {/* Alerta de demora: solo si superó el umbral del negocio */}
                      {slow && (
                        <span className="text-xs px-2 py-0.5 rounded-full font-semibold bg-amber-100 text-amber-700 dark:bg-amber-900/40 dark:text-amber-300">
                          ⚠ {mins} min
                        </span>
                      )}

                      {/* Punto de cierre. Verde = GPS preciso, naranja = referencial. */}
                      {hasClosingPoint(o) ? (
                        <a
                          href={`https://www.google.com/maps?q=${o.closed_lat},${o.closed_lng}`}
                          target="_blank" rel="noopener noreferrer"
                          onClick={ev => ev.stopPropagation()}
                          title={`Precisión aproximada: ${Math.round(o.closed_accuracy ?? 0)} m`}
                          className={`text-xs font-semibold underline underline-offset-2
                            ${accurate ? 'text-green-600 dark:text-green-400' : 'text-orange-500 dark:text-orange-400'}`}>
                          📍 ver punto
                        </a>
                      ) : o.closed_at ? (
                        <span className="text-xs text-gray-300 dark:text-gray-600">📍 sin GPS</span>
                      ) : null}
                    </div>
                    {o.items?.length > 0 && (
                      <div className="text-xs text-gray-500 dark:text-gray-400 mt-1">
                        {o.items.map(i => `${i.quantity}x ${i.product}`).join(' · ')}
                      </div>
                    )}
                  </div>
                </div>

                {/* Quick status change */}
                {next && (
                  <div className="mt-3 flex justify-end">
                    <button
                      onClick={ev => quickStatus(ev, o.id, next)}
                      className={`text-xs font-semibold px-4 py-2 rounded-xl transition-colors
                        ${next === 'En camino' ? 'bg-blue-100 text-blue-700 dark:bg-blue-900/40 dark:text-blue-300' : 'bg-green-100 text-green-700 dark:bg-green-900/40 dark:text-green-300'}`}>
                      → {next}
                    </button>
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}
      <div className="h-4" />
    </div>
  );
}
