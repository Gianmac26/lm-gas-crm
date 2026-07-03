import React, { useState, useEffect, useRef, useCallback } from 'react';
import { useNavigate } from 'react-router-dom';
import { conversations as conversationsApi } from '../api.js';
import { MessageSquare, Search } from 'lucide-react';

const POLL_INTERVAL = 5000;

function fmtTime(s) {
  if (!s) return '';
  const d = new Date(s);
  const now = new Date();
  const diffDays = Math.floor((now - d) / 86400000);
  if (diffDays === 0) return d.toLocaleTimeString('es-PE', { hour: '2-digit', minute: '2-digit' });
  if (diffDays === 1) return 'Ayer';
  if (diffDays < 7)  return d.toLocaleDateString('es-PE', { weekday: 'short' });
  return d.toLocaleDateString('es-PE', { day: '2-digit', month: 'short' });
}

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

const FILTERS = [
  { key: 'all',    label: 'Todas' },
  { key: 'unread', label: 'No leídas' },
  { key: 'open',   label: 'Abiertas' },
  { key: 'closed', label: 'Cerradas' },
];

export default function Conversations() {
  const nav = useNavigate();
  const [all, setAll] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [search, setSearch] = useState('');
  const [filter, setFilter] = useState('all');
  const pollRef = useRef(null);
  const fetchingRef = useRef(false);

  const load = useCallback(async () => {
    if (fetchingRef.current) return;
    fetchingRef.current = true;
    try {
      const data = await conversationsApi.list({ limit: 100 });
      setAll(data.conversations || []);
      setError(null);
    } catch {
      setError('Error al cargar conversaciones. Intenta de nuevo.');
    } finally {
      fetchingRef.current = false;
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    load();

    const startPoll = () => {
      pollRef.current = setInterval(() => {
        if (document.visibilityState !== 'hidden') load();
      }, POLL_INTERVAL);
    };

    const handleVisibility = () => {
      if (document.visibilityState === 'hidden') {
        clearInterval(pollRef.current);
        pollRef.current = null;
      } else {
        load();
        startPoll();
      }
    };

    startPoll();
    document.addEventListener('visibilitychange', handleVisibility);
    return () => {
      clearInterval(pollRef.current);
      document.removeEventListener('visibilitychange', handleVisibility);
    };
  }, [load]);

  const q = search.toLowerCase();
  const filtered = all.filter(c => {
    if (q) {
      const name  = displayName(c).toLowerCase();
      const phone = (c.phone || c.phone_normalized || '').toLowerCase();
      if (!name.includes(q) && !phone.includes(q)) return false;
    }
    if (filter === 'unread') return (c.unread_count || 0) > 0;
    if (filter === 'open')   return c.status === 'open';
    if (filter === 'closed') return c.status === 'closed';
    return true;
  });

  if (loading) {
    return (
      <div className="flex items-center justify-center h-64">
        <div className="animate-spin text-4xl">🔥</div>
      </div>
    );
  }

  return (
    <div className="flex flex-col">
      {/* Search */}
      <div className="px-4 pt-4 pb-2">
        <div className="relative">
          <Search size={16} className="absolute left-3 top-1/2 -translate-y-1/2 text-gray-400" />
          <input
            className="input pl-9 !py-2.5 text-sm"
            placeholder="Buscar por nombre o teléfono…"
            value={search}
            onChange={e => setSearch(e.target.value)}
          />
        </div>
      </div>

      {/* Filter chips */}
      <div className="px-4 pb-3 flex gap-2 overflow-x-auto no-scrollbar">
        {FILTERS.map(f => (
          <button
            key={f.key}
            onClick={() => setFilter(f.key)}
            className={`flex-shrink-0 text-xs font-semibold px-3 py-1.5 rounded-full transition-colors touch-manipulation
              ${filter === f.key
                ? 'bg-orange-500 text-white'
                : 'bg-gray-100 dark:bg-gray-700 text-gray-600 dark:text-gray-300 hover:bg-gray-200 dark:hover:bg-gray-600'}`}
          >
            {f.label}
          </button>
        ))}
      </div>

      {/* Error banner */}
      {error && (
        <div className="mx-4 mb-3 p-3 bg-red-50 dark:bg-red-900/20 border border-red-200 dark:border-red-800 rounded-xl text-sm text-red-600 dark:text-red-400">
          {error}
        </div>
      )}

      {/* List */}
      {filtered.length === 0 ? (
        <div className="flex flex-col items-center justify-center h-48 text-gray-400 text-sm gap-3">
          <MessageSquare size={36} strokeWidth={1.5} />
          {search || filter !== 'all'
            ? 'Sin resultados para esta búsqueda'
            : 'No hay conversaciones aún'}
        </div>
      ) : (
        <div className="divide-y divide-gray-100 dark:divide-gray-700">
          {filtered.map(c => {
            const unread = c.unread_count || 0;
            const name = displayName(c);
            return (
              <button
                key={c.id}
                onClick={() => nav(`/conversations/${c.id}`)}
                className="w-full text-left px-4 py-3.5 flex items-start gap-3 active:bg-gray-50 dark:active:bg-gray-700/50 transition-colors touch-manipulation"
              >
                {/* Avatar */}
                <div className={`flex-shrink-0 w-11 h-11 rounded-2xl flex items-center justify-center text-lg font-bold
                  ${c.status === 'closed'
                    ? 'bg-gray-100 dark:bg-gray-700 text-gray-400 dark:text-gray-500'
                    : 'bg-green-100 dark:bg-green-900/30 text-green-700 dark:text-green-400'}`}>
                  {(name[0] || '?').toUpperCase()}
                </div>

                {/* Content */}
                <div className="flex-1 min-w-0">
                  <div className="flex items-center justify-between gap-2">
                    <span className={`text-sm truncate ${unread > 0 ? 'font-bold text-gray-900 dark:text-white' : 'font-semibold text-gray-800 dark:text-gray-100'}`}>
                      {name}
                    </span>
                    <span className="flex-shrink-0 text-[11px] text-gray-400 dark:text-gray-500">
                      {fmtTime(c.last_message_at)}
                    </span>
                  </div>

                  <div className="flex items-center justify-between gap-2 mt-0.5">
                    <span className={`text-xs truncate ${unread > 0 ? 'text-gray-800 dark:text-gray-200 font-medium' : 'text-gray-500 dark:text-gray-400'}`}>
                      {c.last_message_direction === 'outbound' && (
                        <span className="text-gray-400 dark:text-gray-500">Tú: </span>
                      )}
                      {c.last_message_body
                        ? c.last_message_body
                        : c.last_message_type && c.last_message_type !== 'text'
                          ? <span className="italic">{mediaLabel(c.last_message_type)}</span>
                          : <span className="italic">Sin mensajes</span>}
                    </span>
                    {unread > 0 && (
                      <span className="flex-shrink-0 bg-orange-500 text-white text-[10px] font-bold rounded-full px-1.5 py-0.5 min-w-[18px] text-center leading-none">
                        {unread > 99 ? '99+' : unread}
                      </span>
                    )}
                  </div>

                  {c.status === 'closed' && (
                    <span className="text-[10px] text-gray-400 dark:text-gray-500 font-medium">Cerrada</span>
                  )}
                </div>
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}
