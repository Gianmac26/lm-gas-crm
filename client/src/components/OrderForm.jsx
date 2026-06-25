import React, { useState, useEffect, useRef } from 'react';
import { useParams, useNavigate, useSearchParams } from 'react-router-dom';
import { orders as ordersApi, clients, riders, config, catalog as catalogApi } from '../api.js';
import { ChevronLeft, Save, Plus, Trash2, Search, AlertTriangle, Info } from 'lucide-react';
import toast from 'react-hot-toast';

const PAYMENT_METHODS = ['Efectivo', 'Yape', 'Plin', 'Fiado'];
const STATUSES        = ['Pendiente', 'En camino', 'Entregado', 'Cancelado'];

// ── Legacy PRODUCTS list (fallback only) ──────────────────────────────────────
const LEGACY_PRODUCTS = ['Balón 10kg', 'Balón 40kg', 'Agua bidón 20L', 'Producto de limpieza'];

function legacyPrice(product, prices) {
  if (product === 'Balón 10kg')    return parseFloat(prices?.price_10kg  || 38);
  if (product === 'Balón 40kg')    return parseFloat(prices?.price_40kg  || prices?.price_45kg || 120);
  if (product === 'Agua bidón 20L')return parseFloat(prices?.price_water || 12);
  return parseFloat(prices?.price_cleaning || 15);
}

function emptyLegacyItem(prices) {
  return { product: 'Balón 10kg', description: '', quantity: 1, unit_price: legacyPrice('Balón 10kg', prices) };
}

// ── Catalog item picker ───────────────────────────────────────────────────────
// Non-balón categories are shown as a single pill that reveals their product list.
const SIMPLE_CATEGORIES = [
  { key: 'kit',       label: 'Kit de válvula' },
  { key: 'accesorio', label: 'Productos' },
];

function CatalogPicker({ available, onAdd, onClose }) {
  const balloonProduct = available.find(p => p.category === 'balón');

  const productsByCat = {};
  available.forEach(p => {
    if (p.category === 'balón') return;
    (productsByCat[p.category] = productsByCat[p.category] || []).push(p);
  });
  const simpleCats = SIMPLE_CATEGORIES.filter(c => (productsByCat[c.key] || []).length > 0);

  const [cat, setCat]   = useState(null);
  const [brand, setBrand]     = useState(null);
  const [presKg, setPresKg]   = useState(null);
  const [valve, setValve]     = useState(null);
  const [selProduct, setSelProduct] = useState(null);

  const selectCategory = (key) => {
    setCat(key);
    setBrand(null); setPresKg(null); setValve(null); setSelProduct(null);
  };
  const selectBrand = (b)  => { setBrand(b); setPresKg(null); setValve(null); };
  const selectPres  = (pk) => { setPresKg(pk); setValve(null); };

  const brands = balloonProduct
    ? [...new Set(balloonProduct.variants.map(v => v.brand))].filter(Boolean)
    : [];

  const presentations = (balloonProduct && brand)
    ? [...new Set(balloonProduct.variants.filter(v => v.brand === brand).map(v => v.presentation_kg))].filter(Boolean)
    : [];

  const valveTypes = (balloonProduct && brand && presKg === 10)
    ? [...new Set(balloonProduct.variants.filter(v => v.brand === brand && v.presentation_kg === presKg).map(v => v.valve_type))].filter(Boolean)
    : [];

  const readyVariant = (balloonProduct && brand && presKg)
    ? balloonProduct.variants.find(v =>
        v.brand === brand &&
        v.presentation_kg === presKg &&
        (presKg !== 10 || v.valve_type === valve)
      )
    : null;

  const catProducts = (cat && cat !== 'balón') ? (productsByCat[cat] || []) : [];

  const canAdd = cat === 'balón' ? Boolean(readyVariant)
    : Boolean(selProduct);

  const handleAdd = () => {
    if (!canAdd) return;
    if (cat === 'balón' && readyVariant) {
      onAdd({
        product_id:            balloonProduct.id,
        variant_id:            readyVariant.id,
        product_name_snapshot: [brand, presKg ? `${presKg} kg` : null, valve ? `válvula ${valve}` : null].filter(Boolean).join(' · '),
        category_snapshot:     'balón',
        brand_snapshot:        brand,
        presentation_snapshot: presKg ? `${presKg} kg` : null,
        valve_type_snapshot:   valve || null,
        catalog_unit_price:    readyVariant.sale_price,
        unit_price:            readyVariant.sale_price,
        quantity:              1,
        description:           '',
      });
    } else if (selProduct) {
      onAdd({
        product_id:            selProduct.id,
        variant_id:            null,
        product_name_snapshot: selProduct.name,
        category_snapshot:     selProduct.category,
        brand_snapshot:        null,
        presentation_snapshot: null,
        valve_type_snapshot:   null,
        catalog_unit_price:    selProduct.sale_price,
        unit_price:            selProduct.sale_price,
        quantity:              1,
        description:           '',
      });
    }
    onClose();
  };

  const Pill = ({ label, active, onClick }) => (
    <button type="button" onClick={onClick}
      className={`px-3 py-1.5 rounded-xl text-sm font-medium border transition-colors
        ${active
          ? 'bg-orange-500 text-white border-orange-500'
          : 'bg-gray-100 dark:bg-gray-700 text-gray-700 dark:text-gray-300 border-gray-200 dark:border-gray-600'}`}>
      {label}
    </button>
  );

  return (
    <div className="bg-orange-50 dark:bg-orange-900/20 border border-orange-200 dark:border-orange-800 rounded-xl p-4 space-y-4">
      {/* Category */}
      <div>
        <p className="text-xs font-semibold text-gray-500 dark:text-gray-400 mb-2">Categoría</p>
        <div className="flex flex-wrap gap-2">
          {balloonProduct && <Pill label="Balón de gas" active={cat === 'balón'} onClick={() => selectCategory('balón')} />}
          {simpleCats.map(c => (
            <Pill key={c.key} label={c.label} active={cat === c.key} onClick={() => selectCategory(c.key)} />
          ))}
        </div>
      </div>

      {/* Brand (balón only) */}
      {cat === 'balón' && brands.length > 0 && (
        <div>
          <p className="text-xs font-semibold text-gray-500 dark:text-gray-400 mb-2">Marca</p>
          <div className="flex flex-wrap gap-2">
            {brands.map(b => (
              <Pill key={b} label={b} active={brand === b} onClick={() => selectBrand(b)} />
            ))}
          </div>
        </div>
      )}

      {/* Presentation (balón only) */}
      {cat === 'balón' && brand && presentations.length > 0 && (
        <div>
          <p className="text-xs font-semibold text-gray-500 dark:text-gray-400 mb-2">Presentación</p>
          <div className="flex flex-wrap gap-2">
            {presentations.map(pk => (
              <Pill key={pk} label={`${pk} kg`} active={presKg === pk} onClick={() => selectPres(pk)} />
            ))}
          </div>
        </div>
      )}

      {/* Valve type (10 kg only) */}
      {cat === 'balón' && brand && presKg === 10 && valveTypes.length > 0 && (
        <div>
          <p className="text-xs font-semibold text-gray-500 dark:text-gray-400 mb-2">Tipo de válvula</p>
          <div className="flex flex-wrap gap-2">
            {valveTypes.map(vt => (
              <Pill key={vt} label={`Válvula ${vt}`} active={valve === vt} onClick={() => setValve(vt)} />
            ))}
          </div>
        </div>
      )}

      {/* Product list (kit / productos) */}
      {cat && cat !== 'balón' && catProducts.length > 0 && (
        <div>
          <p className="text-xs font-semibold text-gray-500 dark:text-gray-400 mb-2">Producto</p>
          <div className="flex flex-wrap gap-2">
            {catProducts.map(p => (
              <Pill key={p.id} label={p.name} active={selProduct?.id === p.id} onClick={() => setSelProduct(p)} />
            ))}
          </div>
        </div>
      )}

      {/* Preview & price */}
      {readyVariant && (
        <div className="bg-white dark:bg-gray-800 rounded-lg px-3 py-2 text-sm flex items-center justify-between">
          <span className="text-gray-700 dark:text-gray-300">
            {[brand, presKg ? `${presKg} kg` : null, valve ? `válvula ${valve}` : null].filter(Boolean).join(' · ')}
          </span>
          <span className="font-bold text-orange-500">S/ {readyVariant.sale_price}</span>
        </div>
      )}
      {selProduct && cat !== 'balón' && (
        <div className="bg-white dark:bg-gray-800 rounded-lg px-3 py-2 text-sm flex items-center justify-between">
          <span className="text-gray-700 dark:text-gray-300">{selProduct.name}</span>
          <span className="font-bold text-orange-500">S/ {selProduct.sale_price}</span>
        </div>
      )}

      <div className="flex gap-2">
        <button type="button" onClick={onClose}
          className="flex-1 py-2.5 rounded-xl bg-gray-200 dark:bg-gray-700 text-gray-700 dark:text-gray-300 text-sm font-medium">
          Cancelar
        </button>
        <button type="button" onClick={handleAdd} disabled={!canAdd}
          className={`flex-1 py-2.5 rounded-xl text-sm font-bold transition-colors
            ${canAdd ? 'bg-orange-500 text-white' : 'bg-gray-200 dark:bg-gray-700 text-gray-400 cursor-not-allowed'}`}>
          Agregar ítem
        </button>
      </div>
    </div>
  );
}

// ── Item row ──────────────────────────────────────────────────────────────────
function ItemRow({ item, index, isLegacy, prices, available, onSetItem, onRemove }) {
  const label = item.product_name_snapshot || item.product || '';
  return (
    <div className="space-y-2 p-3 bg-gray-50 dark:bg-gray-700/50 rounded-xl">
      {/* Product name */}
      <div className="flex items-center justify-between">
        <span className="text-sm font-semibold text-gray-800 dark:text-gray-200">{label}</span>
        <button type="button" onClick={() => onRemove(index)} className="text-red-400 px-2">
          <Trash2 size={16} />
        </button>
      </div>
      {/* Description for cleaning articles */}
      {(item.category_snapshot === 'accesorio' || item.product === 'Artículo limpieza' || item.product === 'Producto de limpieza') && (
        <input className="input !py-2" placeholder="Descripción del artículo"
          value={item.description || ''} onChange={e => onSetItem(index, 'description', e.target.value)} />
      )}
      {/* Legacy: product selector */}
      {isLegacy && (
        <select className="input !py-2" value={item.product}
          onChange={e => {
            onSetItem(index, 'product', e.target.value);
            onSetItem(index, 'unit_price', legacyPrice(e.target.value, prices));
          }}>
          {LEGACY_PRODUCTS.map(p => <option key={p}>{p}</option>)}
        </select>
      )}
      <div className="flex gap-2">
        <div className="flex-1">
          <label className="text-xs text-gray-400 mb-1 block">Cantidad</label>
          <input className="input !py-2 text-center" type="number" min="1"
            value={item.quantity}
            onChange={e => onSetItem(index, 'quantity', parseInt(e.target.value) || 1)} />
        </div>
        <div className="flex-1">
          <label className="text-xs text-gray-400 mb-1 block">Precio S/</label>
          <input className="input !py-2 text-center" type="number" min="0" step="0.50"
            value={item.unit_price}
            onChange={e => onSetItem(index, 'unit_price', parseFloat(e.target.value) || 0)} />
        </div>
        <div className="flex-1">
          <label className="text-xs text-gray-400 mb-1 block">Subtotal</label>
          <div className="input !py-2 text-center bg-gray-100 dark:bg-gray-600 text-gray-700 dark:text-gray-300 font-semibold">
            S/ {((item.quantity || 1) * (item.unit_price || 0)).toFixed(0)}
          </div>
        </div>
      </div>
    </div>
  );
}

// ── Main component ────────────────────────────────────────────────────────────
export default function OrderForm() {
  const { id } = useParams();
  const nav = useNavigate();
  const [sp] = useSearchParams();
  const isEdit = Boolean(id);

  const [clientId, setClientId]           = useState(sp.get('client_id') || '');
  const [clientSearch, setClientSearch]   = useState('');
  const [clientResults, setClientResults] = useState([]);
  const [selectedClient, setSelectedClient] = useState(null);
  const [riderId, setRiderId]   = useState('');
  const [payMethod, setPayMethod] = useState('Efectivo');
  const [status, setStatus]     = useState('Pendiente');
  const [notes, setNotes]       = useState('');
  const [items, setItems]       = useState([]);
  const [riderList, setRiderList] = useState([]);
  const [prices, setPrices]     = useState({});
  const [available, setAvailable] = useState(null); // null=loading, []=no catalog
  const [catalogVersion, setCatalogVersion] = useState(1);
  const [showPicker, setShowPicker] = useState(false);
  const [saving, setSaving]     = useState(false);
  const searchRef = useRef(null);

  const isLegacyOrder = isEdit && catalogVersion === 0;

  useEffect(() => {
    riders.list().then(setRiderList);
    config.get().then(cfg => { setPrices(cfg); });
    catalogApi.available().then(setAvailable).catch(() => setAvailable([]));

    if (isEdit) {
      ordersApi.get(id).then(o => {
        setClientId(o.client_id || '');
        setRiderId(o.rider_id || '');
        setPayMethod(o.payment_method || 'Efectivo');
        setStatus(o.status || 'Pendiente');
        setNotes(o.notes || '');
        setCatalogVersion(o.catalog_version || 0);
        setItems(o.items?.map(i => ({ ...i })) || []);
        if (o.client_id) clients.get(o.client_id).then(setSelectedClient).catch(() => {});
      });
    } else {
      const cid = sp.get('client_id');
      if (cid) clients.get(cid).then(setSelectedClient).catch(() => {});
    }
  }, [id]);

  // Show legacy empty item when catalog loads empty and it's a new order
  useEffect(() => {
    if (!isEdit && available !== null && available.length === 0 && items.length === 0) {
      setItems([emptyLegacyItem(prices)]);
      setCatalogVersion(0);
    }
  }, [available]);

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
    setSelectedClient(c);
    setClientSearch('');
    setClientResults([]);
  };

  const setItem = (i, k, v) => {
    setItems(prev => {
      const next = [...prev];
      next[i] = { ...next[i], [k]: v };
      return next;
    });
  };

  const addItem = () => {
    if (available && available.length > 0) {
      setShowPicker(true);
    } else {
      setItems(prev => [...prev, emptyLegacyItem(prices)]);
      setCatalogVersion(0);
    }
  };

  const addCatalogItem = (item) => {
    setItems(prev => [...prev, item]);
    setCatalogVersion(1);
  };

  const removeItem = (i) => setItems(prev => prev.filter((_, j) => j !== i));

  const total = items.reduce((s, i) => s + ((i.quantity || 1) * (i.unit_price || 0)), 0);

  const submit = async (e) => {
    e.preventDefault();
    if (!clientId) return toast.error('Selecciona un cliente');
    if (!items.length) return toast.error('Agrega al menos un producto');
    setSaving(true);
    try {
      const payload = {
        client_id:      clientId,
        rider_id:       riderId || null,
        payment_method: payMethod,
        status,
        notes,
        catalog_version: catalogVersion,
        items: items.map(i => ({
          ...i,
          quantity:   parseInt(i.quantity) || 1,
          unit_price: parseFloat(i.unit_price) || 0,
        })),
      };
      if (isEdit) { await ordersApi.update(id, payload); toast.success('Pedido actualizado'); }
      else        { await ordersApi.create(payload);     toast.success('Pedido registrado');  }
      nav('/orders');
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

      {/* Legacy banner */}
      {isLegacyOrder && (
        <div className="flex items-start gap-2 bg-yellow-50 dark:bg-yellow-900/20 border border-yellow-200 dark:border-yellow-800 rounded-xl px-3 py-2.5">
          <Info size={16} className="text-yellow-600 mt-0.5 shrink-0" />
          <p className="text-xs text-yellow-700 dark:text-yellow-400">
            Pedido registrado antes del nuevo catálogo. Los ítems se editan con el formato original.
          </p>
        </div>
      )}

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
            <button type="button"
              onClick={() => { setClientId(''); setSelectedClient(null); }}
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

        {/* Catalog picker */}
        {showPicker && available && available.length > 0 && (
          <CatalogPicker available={available} onAdd={addCatalogItem} onClose={() => setShowPicker(false)} />
        )}

        {/* Item list */}
        {items.map((item, i) => (
          <ItemRow
            key={i}
            item={item}
            index={i}
            isLegacy={isLegacyOrder || !item.product_name_snapshot}
            prices={prices}
            available={available}
            onSetItem={setItem}
            onRemove={removeItem}
          />
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
