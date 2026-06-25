import React, { useState, useEffect } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { clients, orders as ordersApi, conversations as conversationsApi } from '../api.js';
import {
  Phone, MessageCircle, MapPin, Edit, Trash2, Plus,
  Star, Package, Clock, ChevronLeft, AlertTriangle, MessageSquare
} from 'lucide-react';
import toast from 'react-hot-toast';

const STATUS_BADGE = {
  'Pendiente':  'badge-pending',
  'En camino':  'badge-transit',
  'Entregado':  'badge-delivered',
  'Cancelado':  'badge-cancelled',
};

function fmt(n) { return `S/ ${(n||0).toFixed(0)}`; }
function fmtDate(s) {
  if (!s) return '—';
  return new Date(s).toLocaleDateString('es-PE', { day:'2-digit', month:'short', year:'numeric', hour:'2-digit', minute:'2-digit' });
}

export default function ClientDetail() {
  const { id } = useParams();
  const nav = useNavigate();
  const [client, setClient] = useState(null);
  const [loading, setLoading] = useState(true);
  const [conversation, setConversation] = useState(null);

  useEffect(() => {
    clients.get(id)
      .then(c => {
        setClient(c);
        const q = c.phone_normalized || c.phone;
        if (q) {
          conversationsApi.list({ q, limit: 5 })
            .then(data => {
              const match = (data.conversations || []).find(
                cv => cv.client_id === c.id || cv.phone_normalized === c.phone_normalized
              );
              if (match) setConversation(match);
            })
            .catch(() => {});
        }
      })
      .catch(() => toast.error('Error al cargar cliente'))
      .finally(() => setLoading(false));
  }, [id]);

  const handleDelete = async () => {
    if (!confirm(`¿Eliminar a ${client.name}? Esta acción no se puede deshacer.`)) return;
    await clients.delete(id);
    toast.success('Cliente eliminado');
    nav('/clients');
  };

  if (loading) return <div className="flex items-center justify-center h-64"><div className="animate-spin text-4xl">🔥</div></div>;
  if (!client) return <div className="p-4 text-center text-gray-500">Cliente no encontrado</div>;

  const daysAgo = client.orders?.length > 0
    ? Math.floor((Date.now() - new Date(client.orders[0].created_at)) / 86400000)
    : null;

  return (
    <div className="p-4 space-y-4">
      {/* Back */}
      <button onClick={() => nav('/clients')} className="flex items-center gap-1 text-blue-700 dark:text-blue-400 font-medium -ml-1">
        <ChevronLeft size={20} /> Clientes
      </button>

      {/* Header card */}
      <div className="card p-5">
        <div className="flex items-start justify-between">
          <div className="flex items-center gap-3">
            <div className={`w-14 h-14 rounded-2xl flex items-center justify-center text-2xl font-bold
              ${client.type === 'Negocio' ? 'bg-blue-100 text-blue-700' : 'bg-orange-100 text-orange-600'}`}>
              {client.name[0].toUpperCase()}
            </div>
            <div>
              <div className="flex items-center gap-2">
                {client.is_vip ? <Star size={16} className="text-yellow-500 fill-yellow-500" /> : null}
                <h2 className="text-xl font-bold text-gray-900 dark:text-white">{client.name}</h2>
              </div>
              <span className={`text-xs px-2 py-0.5 rounded-full font-medium
                ${client.type === 'Negocio' ? 'bg-blue-100 text-blue-700' : 'bg-gray-100 text-gray-600'}`}>
                {client.type}{client.business_type ? ` · ${client.business_type}` : ''}
              </span>
            </div>
          </div>
          <button onClick={() => nav(`/clients/${id}/edit`)} className="btn-ghost !py-2 !px-3">
            <Edit size={16} />
          </button>
        </div>

        {/* Deuda alert */}
        {client.debt > 0 && (
          <div className="mt-3 bg-red-50 dark:bg-red-900/20 border border-red-200 dark:border-red-800 rounded-xl p-3 flex items-center gap-2">
            <AlertTriangle size={18} className="text-red-500" />
            <span className="font-semibold text-red-600 dark:text-red-400">Deuda pendiente: {fmt(client.debt)}</span>
          </div>
        )}

        {/* Info grid */}
        <div className="mt-4 grid grid-cols-1 gap-2 text-sm">
          {client.address && (
            <div className="flex items-start gap-2 text-gray-600 dark:text-gray-400">
              <MapPin size={15} className="mt-0.5 flex-shrink-0 text-gray-400" />
              <span>{client.address}{client.reference ? ` · ${client.reference}` : ''}</span>
            </div>
          )}
          <div className="flex items-center gap-4 mt-1">
            <span className="text-gray-500">📍 {client.zone}</span>
            <span className="text-gray-500">🛒 {client.preferred_balloon}</span>
            <span className="text-gray-500">📅 {client.purchase_frequency}</span>
          </div>
          {client.notes && (
            <p className="text-gray-500 dark:text-gray-400 italic text-xs mt-1">📝 {client.notes}</p>
          )}
          {daysAgo !== null && daysAgo >= 7 && (
            <p className="text-yellow-600 dark:text-yellow-400 font-medium text-xs">
              ⚠ Sin pedir hace {daysAgo} días
            </p>
          )}
        </div>

        {/* Action buttons */}
        {client.phone && (
          <div className="flex gap-2 mt-4">
            <a
              href={`tel:${client.phone}`}
              className="flex-1 flex items-center justify-center gap-2 bg-blue-900 text-white rounded-xl py-3 font-semibold text-sm active:bg-blue-950"
            >
              <Phone size={16} /> Llamar
            </a>
            <a
              href={`https://wa.me/51${client.phone}`}
              target="_blank" rel="noopener noreferrer"
              className="flex-1 flex items-center justify-center gap-2 bg-green-500 text-white rounded-xl py-3 font-semibold text-sm active:bg-green-600"
            >
              <MessageCircle size={16} /> WhatsApp
            </a>
          </div>
        )}
        {conversation && (
          <button
            onClick={() => nav(`/conversations/${conversation.id}`)}
            className="w-full flex items-center justify-center gap-2 bg-orange-500 text-white rounded-xl py-3 font-semibold text-sm active:bg-orange-600 mt-2"
          >
            <MessageSquare size={16} /> Abrir conversación en CRM
          </button>
        )}
      </div>

      {/* Stats row */}
      <div className="grid grid-cols-3 gap-3">
        <div className="card p-3 text-center">
          <div className="text-xl font-bold text-gray-900 dark:text-white">{client.orders?.length || 0}</div>
          <div className="text-xs text-gray-500 mt-0.5">Pedidos</div>
        </div>
        <div className="card p-3 text-center">
          <div className="text-xl font-bold text-gray-900 dark:text-white">
            {fmt(client.orders?.filter(o => o.status === 'Entregado').reduce((s, o) => s + o.total, 0))}
          </div>
          <div className="text-xs text-gray-500 mt-0.5">Total gastado</div>
        </div>
        <div className="card p-3 text-center">
          <div className="text-xl font-bold text-gray-900 dark:text-white">
            {daysAgo !== null ? `${daysAgo}d` : '—'}
          </div>
          <div className="text-xs text-gray-500 mt-0.5">Último pedido</div>
        </div>
      </div>

      {/* New order */}
      <button
        onClick={() => nav(`/orders/new?client_id=${id}&client_name=${encodeURIComponent(client.name)}`)}
        className="btn-primary w-full flex items-center justify-center gap-2"
      >
        <Plus size={18} /> Nuevo Pedido
      </button>

      {/* Order history */}
      <div>
        <h3 className="font-bold text-gray-800 dark:text-gray-200 mb-3 flex items-center gap-2">
          <Clock size={16} /> Historial de pedidos
        </h3>
        {!client.orders?.length ? (
          <div className="card p-6 text-center text-gray-400 text-sm">Sin pedidos registrados</div>
        ) : (
          <div className="space-y-2">
            {client.orders.map(o => (
              <div key={o.id} className="card p-3">
                <div className="flex items-center justify-between">
                  <span className={`text-xs px-2 py-0.5 rounded-full font-medium ${STATUS_BADGE[o.status] || ''}`}>
                    {o.status}
                  </span>
                  <span className="font-bold text-gray-900 dark:text-white">{fmt(o.total)}</span>
                </div>
                <div className="text-xs text-gray-400 mt-1.5">{fmtDate(o.created_at)}</div>
                {o.items?.length > 0 && (
                  <div className="text-xs text-gray-500 dark:text-gray-400 mt-1">
                    {o.items.map(i => `${i.quantity}x ${i.product_name_snapshot || i.product}`).join(' · ')}
                  </div>
                )}
                <div className="text-xs text-gray-400 mt-1">{o.payment_method} · {o.rider_name || 'Sin asignar'}</div>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* Delete */}
      <button onClick={handleDelete} className="w-full flex items-center justify-center gap-2 text-red-500 py-3 text-sm font-medium">
        <Trash2 size={16} /> Eliminar cliente
      </button>
      <div className="h-4" />
    </div>
  );
}
