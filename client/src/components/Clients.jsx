import React, { useState, useEffect, useCallback, useRef } from 'react';
import { useNavigate } from 'react-router-dom';
import { clients } from '../api.js';
import { Plus, Search, Star, ChevronRight, ChevronDown, MapPin, Users2, Download } from 'lucide-react';

const ZONE_OPTIONS = [
  { value: '', label: 'Todas' },
  { value: 'San Borja', label: 'San Borja' },
  { value: 'Surco', label: 'Surco' },
  { value: 'Surquillo', label: 'Surquillo' },
  { value: 'Miraflores', label: 'Miraflores' },
  { value: 'Otra', label: 'Otra' },
];
const TYPE_OPTIONS = [
  { value: '', label: 'Todos' },
  { value: 'Residencial', label: 'Residencial' },
  { value: 'Negocio', label: 'Negocio' },
];
const SORT_OPTIONS = [
  { value: '', label: 'Pedido más antiguo' },
  { value: 'recent', label: 'Pedido más reciente' },
  { value: 'orders_desc', label: 'Más pedidos primero' },
];

function daysAgo(dateStr) {
  if (!dateStr) return null;
  return Math.floor((Date.now() - new Date(dateStr)) / 86400000);
}

// Botón que despliega una lista de opciones (distrito, tipo de cliente, orden).
// Muestra el nombre de la opción seleccionada; el primer valor de `options`
// se trata como el "sin filtro" (no resalta el botón cuando está activo).
function FilterDropdown({ label, value, options, onChange, activeClass }) {
  const [open, setOpen] = useState(false);
  const ref = useRef(null);

  useEffect(() => {
    if (!open) return;
    const onClickOutside = (e) => { if (ref.current && !ref.current.contains(e.target)) setOpen(false); };
    document.addEventListener('mousedown', onClickOutside);
    return () => document.removeEventListener('mousedown', onClickOutside);
  }, [open]);

  const selected = options.find(o => o.value === value) || options[0];
  const isActive = selected.value !== options[0].value;

  return (
    <div className="relative flex-shrink-0" ref={ref}>
      <button
        onClick={() => setOpen(o => !o)}
        className={`flex items-center gap-1 px-3 py-1.5 rounded-full text-sm font-medium whitespace-nowrap transition-colors
          ${isActive ? activeClass : 'bg-gray-100 dark:bg-gray-800 text-gray-600 dark:text-gray-400'}`}
      >
        {isActive ? selected.label : label}
        <ChevronDown size={14} className={`transition-transform ${open ? 'rotate-180' : ''}`} />
      </button>
      {open && (
        <div className="absolute z-20 mt-1 min-w-[10rem] rounded-xl bg-white dark:bg-gray-800 shadow-lg border border-gray-100 dark:border-gray-700 py-1">
          {options.map(o => (
            <button
              key={o.value || 'all'}
              onClick={() => { onChange(o.value); setOpen(false); }}
              className={`block w-full text-left px-4 py-2 text-sm whitespace-nowrap
                ${o.value === value ? 'font-semibold text-blue-900 dark:text-blue-400' : 'text-gray-700 dark:text-gray-300'}
                hover:bg-gray-50 dark:hover:bg-gray-700`}
            >
              {o.label}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

export default function Clients() {
  const [list, setList] = useState([]);
  const [q, setQ] = useState('');
  const [zone, setZone] = useState('');
  const [type, setType] = useState('');
  const [sort, setSort] = useState('');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const nav = useNavigate();
  const loadSeq = useRef(0);

  const load = useCallback(async () => {
    const seq = ++loadSeq.current;
    setLoading(true);
    setError(null);
    try {
      const params = {};
      if (q)    params.q    = q;
      if (zone) params.zone = zone;
      if (type) params.type = type;
      if (sort) params.sort = sort;
      const data = await clients.list(params);
      if (seq === loadSeq.current) setList(data);
    } catch (err) {
      if (seq === loadSeq.current) {
        setError(err.response?.data?.error || err.message || 'Error al cargar clientes');
        setList([]);
      }
    } finally {
      if (seq === loadSeq.current) setLoading(false);
    }
  }, [q, zone, type, sort]);

  useEffect(() => { const t = setTimeout(load, 250); return () => clearTimeout(t); }, [load]);

  const exportExcel = () => {
    const params = {};
    if (q) params.q = q;
    if (zone) params.zone = zone;
    if (type) params.type = type;
    window.open(clients.exportUrl(params), '_blank');
  };

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
      <div className="flex flex-wrap gap-2 pb-1">
        <FilterDropdown
          label="Distrito" value={zone} options={ZONE_OPTIONS} onChange={setZone}
          activeClass="bg-blue-900 text-white"
        />
        <FilterDropdown
          label="Tipo de cliente" value={type} options={TYPE_OPTIONS} onChange={setType}
          activeClass="bg-orange-500 text-white"
        />
        <FilterDropdown
          label="Ordenar por" value={sort} options={SORT_OPTIONS} onChange={setSort}
          activeClass="bg-gray-700 text-white dark:bg-gray-600"
        />
      </div>

      {/* Count + add */}
      <div className="flex items-center justify-between">
        <p className="text-sm text-gray-500 dark:text-gray-400">{list.length} clientes</p>
        <div className="flex items-center gap-2">
          <button onClick={exportExcel} className="!py-2 !px-4 flex items-center gap-1.5 text-sm font-medium rounded-xl bg-green-600 text-white active:bg-green-700">
            <Download size={16} /> Exportar Excel
          </button>
          <button onClick={() => nav('/clients/new')} className="btn-primary !py-2 !px-4 flex items-center gap-1.5 text-sm">
            <Plus size={16} /> Nuevo
          </button>
        </div>
      </div>

      {/* Error */}
      {error && (
        <div className="rounded-xl bg-red-50 dark:bg-red-900/20 border border-red-200 dark:border-red-800 p-4 text-sm text-red-700 dark:text-red-400">
          ⚠ {error}
        </div>
      )}

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
