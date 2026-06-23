import React, { useState, useEffect, useRef } from 'react';
import { useParams, useNavigate, useSearchParams } from 'react-router-dom';
import { orders as ordersApi, clients, riders, config } from '../api.js';
import { ChevronLeft, Save, Plus, Trash2, Search, AlertTriangle } from 'lucide-react';
import toast from 'react-hot-toast';

const PRODUCTS = ['Balón 10kg', 'Balón 40kg', 'Agua bidón 20L', 'Artículo limpieza'];
const PAYMENT_METHODS = ['Efectivo', 'Yape', 'Plin', 'Fiado'];
const STATUSES = ['Pendiente', 'En camino', 'Entregado', 'Cancelado'];

function emptyItem(prices) {
  return { product: 'Balón 10kg', description: '', quantity: 1, unit_price: parseFloat(prices?.price_10kg || 38) };
}

export default function OrderForm() {
  const { id } = useParams();
  const nav = useNavigate();
  const [sp] = useSearchParams();
  const isEdit = Boolean(id);

  const [clientId, setClientId] = useState(sp.get('client_id') || '');
  const [clientName, setClientName] = useState(sp.get('client_name') || '');
  const [clientSearch, setClientSearch] = useState('');
  const [clientResults, setClientResults] = useState([]);
  const [selectedClient, setSelectedClient] = useState(null);
  const [riderId, setRiderId] = useState('');
  const [payMethod, setPayMethod] = useState('Efectivo');
  const [status, setStatus] = useState('Pendiente');
  const [notes, setNotes] = useState('');
  const [items, setItems] = useState([]);
  const [riderList, setRiderList] = useState([]);
  const [prices, setPrices] = useState({});
  const [saving, setSaving] = useState(false);
  const searchRef = useRef(null);

  useEffect(() => {
    riders.list().then(setRiderList);
    config.get().then(cfg => {
      setPrices(cfg);
      if (!isEdit) setItems([emptyItem(cfg)]);
    });
    if (isEdit) {
      ordersApi.get(id).then(o => {
        setClientId(o.client_id);
        setClientName(o.client_name || '');
        setRiderId(o.rider_id || '');
        setPayMethod(o.payment_method || 'Efectivo');
        setStatus(o.status || 'Pendiente');
        setNotes(o.notes || '');
        setItems(o.items?.map(i => ({ ...i, unit_price: i.unit_price })) || []);
        if (o.client_id) clients.get(o.client_id).then(setSelectedClient).catch(() => {});
      });
    } else if (sp.get('client_id')) {
      clients.get(sp.get('client_id')).then(setSelectedClient).catch(() => {});
    }
  }, [id]);

  // Client search
  useEffect(() => {
    if (!clientSearch || clientSearch.length < 2) { setClientResults([]); return; }
    const t = setTimeout(async () => {
      const res = await clients.list({ q: clientSearch });
      setClientResults(res.slice(0, 5));
    }, 250);
    return () => clearTimeout(t);
  }, [clientSearch]);

  const selectClient = (c) => {
    setClientId(c.id);
    setClientName(c.name);
    setSelectedClient(c);
    setClientSearch('');
    setClientResults([]);
  };

  const productPrice = (product) => {
    if (product === 'Balón 10kg') return parseFloat(prices.price_10kg || 38);
    if (product === 'Balón 40kg') return parseFloat(prices.price_40kg || 120);
    if (product === 'Agua bidón 20L') return parseFloat(prices.price_water || 12);
    return parseFloat(prices.price_cleaning || 15);
  };

  const setItem = (i, k, v) => {
    setItems(prev => {
      const next = [...prev];
      next[i] = { ...next[i], [k]: v };
      if (k === 'product') next[i].unit_price = productPrice(v);
      return next;
    });
  };

  const addItem = () => setItems(prev => [...prev, emptyItem(prices)]);
  const removeItem = (i) => setItems(prev => prev.filter((_, j) => j !== i));

  const total = items.reduce((s, i) => s + (i.quantity * i.unit_price), 0);

  const submit = async (e) => {
    e.preventDefault();
    if (!clientId) return toast.error('Selecciona un cliente');
    if (!items.length) return toast.error('Agrega al menos un producto');
    setSaving(true);
    try {
      const payload = {
        client_id: clientId, rider_id: riderId || null,
        payment_method: payMethod, status, notes,
        items: items.map(i => ({ ...i, quantity: parseInt(i.quantity) || 1, unit_price: parseFloat(i.unit_price) || 0 })),
      };
      if (isEdit) { await ordersApi.update(id, payload); toast.success('Pedido actualizado'); nav('/orders'); }
      else { await ordersApi.create(payload); toast.success('✅ Pedido registrado'); nav('/orders'); }
    } catch { toast.error('Error al guardar'); }
    finally { setSaving(false); }
  };

  return (
    <form onSubmit={submit} className="p-4 space-y-4">
      <button type="button" onClick={() => nav(-1)} className="flex items-center gap-1 text-blue-700 dark:text-blue-400 font-medium -ml-1">
        <ChevronLeft size={20} /> Volver
      </button>
      <h2 className="text-xl font-bold text-gray-900 dark:text-white">
        {isEdit ? 'Editar pedido' : 'Nuevo pedido'}
      </h2>

      {/* Client */}
      <div className="card p-4 space-y-3">
        <label className="label">Cliente *</label>
        {selectedClient ? (
          <div className="flex items-center justify-between bg-blue-50 dark:bg-blue-900/20 rounded-xl p-3">
            <div>
              <p className="font-semibold text-gray-900 dark:text-white">{selectedClient.name}</p>
              <p className="text-xs text-gray-500">{selectedClient.address} · {selectedClient.zone}</p>
              {selectedClient.debt > 50 && (
                <p className="text-xs text-red-500 font-semibold flex items-center gap-1 mt-1">
                  <AlertTriangle size={12} /> Deuda: S/ {selectedClient.debt.toFixed(0)}
                </p>
              )}
            </div>
            <button type="button" onClick={() => { setClientId(''); setClientName(''); setSelectedClient(null); }}
              className="text-xs text-blue-600 font-medium">Cambiar</button>
          </div>
        ) : (
          <div className="relative">
            <Search size={16} className="absolute left-3 top-1/2 -translate-y-1/2 text-gray-400" />
            <input
              ref={searchRef}
              className="input pl-9"
              placeholder="Buscar cliente por nombre o teléfono..."
              value={clientSearch}
              onChange={e => setClientSearch(e.target.value)}
            />
            {clientResults.length > 0 && (
              <div className="absolute z-20 top-full left-0 right-0 mt-1 bg-white dark:bg-gray-800 rounded-xl shadow-xl border border-gray-200 dark:border-gray-700 overflow-hidden">
                {clientResults.map(c => (
                  <button key={c.id} type="button"
                    onClick={() => selectClient(c)}
                    className="w-full text-left px-4 py-3 hover:bg-gray-50 dark:hover:bg-gray-700 border-b border-gray-100 dark:border-gray-700 last:border-0">
                    <p className="font-medium text-gray-900 dark:text-white">{c.name}</p>
                    <p className="text-xs text-gray-400">{c.phone} · {c.zone}</p>
                  </button>
                ))}
              </div>
            )}
          </div>
        )}
      </div>

      {/* Products */}
      <div className="card p-4 space-y-3">
        <div className="flex items-center justify-between">
          <label className="label !mb-0">Productos</label>
          <button type="button" onClick={addItem} className="text-sm text-orange-500 font-semibold flex items-center gap-1">
            <Plus size={16} /> Agregar
          </button>
        </div>
        {items.map((item, i) => (
          <div key={i} className="space-y-2 p-3 bg-gray-50 dark:bg-gray-700/50 rounded-xl">
            <div className="flex gap-2">
              <select className="input flex-1 !py-2"
                value={item.product}
                onChange={e => setItem(i, 'product', e.target.value)}>
                {PRODUCTS.map(p => <option key={p}>{p}</option>)}
              </select>
              <button type="button" onClick={() => removeItem(i)} className="text-red-400 px-2">
                <Trash2 size={16} />
              </button>
            </div>
            {item.product === 'Artículo limpieza' && (
              <input className="input !py-2" placeholder="Descripción del artículo"
                value={item.description} onChange={e => setItem(i, 'description', e.target.value)} />
            )}
            <div className="flex gap-2">
              <div className="flex-1">
                <label className="text-xs text-gray-400 mb-1 block">Cantidad</label>
                <input className="input !py-2 text-center" type="number" min="1"
                  value={item.quantity} onChange={e => setItem(i, 'quantity', parseInt(e.target.value) || 1)} />
              </div>
              <div className="flex-1">
                <label className="text-xs text-gray-400 mb-1 block">Precio S/</label>
                <input className="input !py-2 text-center" type="number" min="0" step="0.50"
                  value={item.unit_price} onChange={e => setItem(i, 'unit_price', parseFloat(e.target.value) || 0)} />
              </div>
              <div className="flex-1">
                <label className="text-xs text-gray-400 mb-1 block">Subtotal</label>
                <div className="input !py-2 text-center bg-gray-100 dark:bg-gray-600 text-gray-700 dark:text-gray-300 font-semibold">
                  S/ {(item.quantity * item.unit_price).toFixed(0)}
                </div>
              </div>
            </div>
          </div>
        ))}
        <div className="flex justify-between items-center pt-2 border-t border-gray-200 dark:border-gray-700">
          <span className="font-bold text-gray-700 dark:text-gray-300">Total</span>
          <span className="text-2xl font-bold text-orange-500">S/ {total.toFixed(0)}</span>
        </div>
      </div>

      {/* Payment & Rider */}
      <div className="card p-4 space-y-4">
        <div>
          <label className="label">Forma de pago</label>
          <div className="grid grid-cols-4 gap-2">
            {PAYMENT_METHODS.map(m => (
              <button key={m} type="button"
                onClick={() => setPayMethod(m)}
                className={`py-2.5 rounded-xl text-sm font-medium transition-colors
                  ${payMethod === m
                    ? (m === 'Fiado' ? 'bg-red-500 text-white' : 'bg-orange-500 text-white')
                    : 'bg-gray-100 dark:bg-gray-700 text-gray-600 dark:text-gray-300'}`}>
                {m}
              </button>
            ))}
          </div>
          {payMethod === 'Fiado' && (
            <p className="text-xs text-red-500 mt-2 flex items-center gap-1">
              <AlertTriangle size={12} /> Se agregará S/ {total.toFixed(0)} a la deuda del cliente
            </p>
          )}
        </div>
        <div>
          <label className="label">Asignar a motorizado</label>
          <select className="input" value={riderId} onChange={e => setRiderId(e.target.value)}>
            <option value="">Sin asignar</option>
            {riderList.map(r => <option key={r.id} value={r.id}>{r.name}</option>)}
          </select>
        </div>
        {isEdit && (
          <div>
            <label className="label">Estado del pedido</label>
            <div className="grid grid-cols-2 gap-2">
              {STATUSES.map(s => (
                <button key={s} type="button"
                  onClick={() => setStatus(s)}
                  className={`py-2.5 rounded-xl text-sm font-medium transition-colors
                    ${status === s ? 'bg-blue-900 text-white' : 'bg-gray-100 dark:bg-gray-700 text-gray-600 dark:text-gray-300'}`}>
                  {s}
                </button>
              ))}
            </div>
          </div>
        )}
        <div>
          <label className="label">Notas del pedido</label>
          <textarea className="input resize-none" rows={2}
            placeholder="Instrucciones especiales..." value={notes}
            onChange={e => setNotes(e.target.value)} />
        </div>
      </div>

      <button type="submit" disabled={saving} className="btn-primary w-full flex items-center justify-center gap-2 py-4 text-base">
        <Save size={18} /> {saving ? 'Guardando...' : isEdit ? 'Actualizar pedido' : `Registrar pedido · S/ ${total.toFixed(0)}`}
      </button>
      <div className="h-4" />
    </form>
  );
}
