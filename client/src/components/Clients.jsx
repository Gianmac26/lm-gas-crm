import React, { useState, useEffect, useCallback } from 'react';
import { useNavigate } from 'react-router-dom';
import { clients } from '../api.js';
import { Plus, Search, Star, ChevronRight, MapPin, Phone } from 'lucide-react';

const ZONES = ['Todas', 'San Borja', 'Surco', 'Miraflores', 'Otra'];
const TYPES = ['Todos', 'Residencial', 'Negocio'];

function daysAgo(dateStr) {
  if (!dateStr) return null;
  return Math.floor((Date.now() - new Date(dateStr)) / 86400000);
}

export default function Clients() {
  const [list, setList] = useState([]);
  const [q, setQ] = useState('');
  const [zone, setZone] = useState('');
  const [type, setType] = useState('');
  const [loading, setLoading] = useState(true);
  const nav = useNavigate();

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const params = {};
      if (q)    params.q    = q;
      if (zone && zone !== 'Todas') params.zone = zone;
      if (type && type !== 'Todos') params.type = type;
      setList(await clients.list(params));
    } finally { setLoading(false); }
  }, [q, zone, type]);

  useEffect(() => { const t = setTimeout(load, 250); return () => clearTimeout(t); }, [load]);

  return (
    <div className="p-4 space-y-3">
      {/* Search */}
      <div className="relative">
        <Search size={18} className="absolute left-3.5 top-1/2 -translate-y-1/2 text-gray-400" />
        <input
          className="input pl-10"
          placeholder="Buscar por nombre, dirección o teléfono..."
          value={q}
          onChange={e => setQ(e.target.value)}
        />
      </div>

      {/* Filters */}
      <div className="flex gap-2 overflow-x-auto no-scrollbar pb-1">
        {ZONES.map(z => (
          <button
            key={z}
            onClick={() => setZone(z === 'Todas' ? '' : z)}
            className={`flex-shrink-0 px-3 py-1.5 rounded-full text-sm font-medium transition-colors
              ${(zone === z || (!zone && z === 'Todas'))
                ? 'bg-blue-900 text-white'
                : 'bg-gray-100 dark:bg-gray-800 text-gray-600 dark:text-gray-400'}`}
          >
            {z}
          </button>
        ))}
        <div className="w-px bg-gray-200 dark:bg-gray-700 mx-1" />
        {TYPES.map(t => (
          <button
            key={t}
            onClick={() => setType(t === 'Todos' ? '' : t)}
            className={`flex-shrink-0 px-3 py-1.5 rounded-full text-sm font-medium transition-colors
              ${(type === t || (!type && t === 'Todos'))
                ? 'bg-orange-500 text-white'
                : 'bg-gray-100 dark:bg-gray-800 text-gray-600 dark:text-gray-400'}`}
          >
            {t}
          </button>
        ))}
      </div>

      {/* Count + add */}
      <div className="flex items-center justify-between">
        <p className="text-sm text-gray-500 dark:text-gray-400">{list.length} clientes</p>
        <button onClick={() => nav('/clients/new')} className="btn-primary !py-2 !px-4 flex items-center gap-1.5 text-sm">
          <Plus size={16} /> Nuevo
        </button>
      </div>

      {/* List */}
      {loading ? (
        <div className="space-y-3">
          {[1,2,3].map(i => <div key={i} className="card h-20 animate-pulse bg-gray-100 dark:bg-gray-800" />)}
        </div>
      ) : list.length === 0 ? (
        <div className="text-center py-16 text-gray-400">
          <Users2 size={48} className="mx-auto mb-3 opacity-30" />
          <p>No se encontraron clientes</p>
        </div>
      ) : (
        <div className="space-y-2">
          {list.map(c => {
            const days = daysAgo(c.last_order);
            const inactive = days === null || days >= 7;
            return (
              <div
                key={c.id}
                onClick={() => nav(`/clients/${c.id}`)}
                className="card p-4 flex items-center gap-3 cursor-pointer active:scale-[0.98] transition-transform"
              >
                {/* Avatar */}
                <div className={`w-12 h-12 rounded-xl flex items-center justify-center text-lg font-bold flex-shrink-0
                  ${c.type === 'Negocio' ? 'bg-blue-100 dark:bg-blue-900/40 text-blue-700' : 'bg-orange-100 dark:bg-orange-900/40 text-orange-600'}`}>
                  {c.name[0].toUpperCase()}
                </div>

                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-1.5">
                    {c.is_vip ? <Star size={13} className="text-yellow-500 fill-yellow-500 flex-shrink-0" /> : null}
                    <span className="font-semibold text-gray-900 dark:text-white truncate">{c.name}</span>
                  </div>
                  <div className="flex items-center gap-1 text-xs text-gray-500 dark:text-gray-400 mt-0.5">
                    <MapPin size={11} />
                    <span className="truncate">{c.zone} · {c.address || 'Sin dirección'}</span>
                  </div>
                  <div className="flex items-center gap-3 mt-1">
                    <span className="text-xs text-gray-400">{c.order_count || 0} pedidos</span>
                    {c.debt > 0 && (
                      <span className="text-xs font-semibold text-red-500">Debe S/ {c.debt.toFixed(0)}</span>
                    )}
                    {inactive && (
                      <span className="text-xs text-yellow-600 dark:text-yellow-400">
                        {days === null ? '⚠ Sin pedidos' : `⚠ ${days}d sin pedir`}
                      </span>
                    )}
                  </div>
                </div>

                <ChevronRight size={18} className="text-gray-300 dark:text-gray-600 flex-shrink-0" />
              </div>
            );
          })}
        </div>
      )}
      <div className="h-4" />
    </div>
  );
}
