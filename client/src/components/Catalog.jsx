import React, { useState, useEffect } from 'react';
import { catalog as catalogApi } from '../api.js';
import { Package, ChevronDown, ChevronRight, Edit, Check, X } from 'lucide-react';
import toast from 'react-hot-toast';

const CATEGORY_LABELS = {
  'balón':    '🔥 Balón de gas',
  'válvula':  '🔧 Válvulas',
  'kit':      '📦 Kit',
  'accesorio':'💧 Accesorios',
  'otro':     'Otros',
};

function isPending(item) {
  return !item.active || (item.sale_price == null || item.sale_price <= 0);
}

function PriceEditor({ value, onSave, onCancel }) {
  const [val, setVal] = useState(String(value || ''));
  return (
    <span className="inline-flex items-center gap-1">
      <span className="text-gray-400 text-xs">S/</span>
      <input
        className="input !py-1 !px-2 w-20 text-sm text-center"
        type="number" min="0" step="0.50"
        value={val}
        onChange={e => setVal(e.target.value)}
        autoFocus
      />
      <button onClick={() => onSave(parseFloat(val) || 0)} className="text-green-600 hover:text-green-700"><Check size={14} /></button>
      <button onClick={onCancel} className="text-gray-400 hover:text-gray-600"><X size={14} /></button>
    </span>
  );
}

function VariantRow({ variant, onUpdate }) {
  const [editingPrice, setEditingPrice] = useState(false);
  const pending = isPending(variant);

  const toggleActive = async () => {
    if (!variant.active && (!variant.sale_price || variant.sale_price <= 0)) {
      return toast.error('Configura el precio antes de activar');
    }
    try {
      await catalogApi.updateVariant(variant.id, { active: !variant.active });
      onUpdate();
      toast.success(variant.active ? 'Variante desactivada' : 'Variante activada');
    } catch (e) { toast.error(e.response?.data?.error || 'Error'); }
  };

  const savePrice = async (price) => {
    try {
      await catalogApi.updateVariant(variant.id, { sale_price: price });
      setEditingPrice(false);
      onUpdate();
      toast.success('Precio actualizado');
    } catch (e) { toast.error(e.response?.data?.error || 'Error'); }
  };

  const label = [
    variant.brand,
    variant.presentation_kg ? `${variant.presentation_kg} kg` : null,
    variant.valve_type ? `válvula ${variant.valve_type}` : null,
  ].filter(Boolean).join(' · ');

  return (
    <div className={`flex items-center justify-between py-2 px-3 rounded-lg text-sm
      ${pending ? 'bg-yellow-50 dark:bg-yellow-900/20' : 'bg-gray-50 dark:bg-gray-800/50'}`}>
      <div className="flex items-center gap-2 flex-1 min-w-0">
        {pending && <span className="badge-pending text-xs shrink-0">Pendiente</span>}
        <span className="text-gray-700 dark:text-gray-300 truncate">{label}</span>
      </div>
      <div className="flex items-center gap-3 shrink-0">
        {editingPrice ? (
          <PriceEditor value={variant.sale_price} onSave={savePrice} onCancel={() => setEditingPrice(false)} />
        ) : (
          <button
            onClick={() => setEditingPrice(true)}
            className="flex items-center gap-1 text-gray-500 hover:text-gray-700 dark:text-gray-400"
          >
            <span className="font-semibold">{variant.sale_price > 0 ? `S/ ${variant.sale_price}` : '—'}</span>
            <Edit size={12} />
          </button>
        )}
        <button
          onClick={toggleActive}
          className={`text-xs px-2 py-0.5 rounded-full font-medium border transition-colors
            ${variant.active
              ? 'bg-green-100 text-green-700 border-green-200 dark:bg-green-900/30 dark:text-green-400'
              : 'bg-gray-100 text-gray-500 border-gray-200 dark:bg-gray-800 dark:text-gray-500'}`}
        >
          {variant.active ? 'Activo' : 'Inactivo'}
        </button>
      </div>
    </div>
  );
}

function ProductCard({ product, onUpdate }) {
  const [open, setOpen] = useState(false);
  const [editingPrice, setEditingPrice] = useState(false);
  const pending = isPending(product);
  const hasVariants = product.variants?.length > 0;
  const pendingVariants = hasVariants ? product.variants.filter(isPending).length : 0;

  const toggleActive = async () => {
    if (!product.active && (!product.sale_price || product.sale_price <= 0) && !hasVariants) {
      return toast.error('Configura el precio antes de activar');
    }
    try {
      await catalogApi.updateProduct(product.id, { active: !product.active });
      onUpdate();
      toast.success(product.active ? 'Producto desactivado' : 'Producto activado');
    } catch (e) { toast.error(e.response?.data?.error || 'Error'); }
  };

  const savePrice = async (price) => {
    try {
      await catalogApi.updateProduct(product.id, { sale_price: price });
      setEditingPrice(false);
      onUpdate();
      toast.success('Precio actualizado');
    } catch (e) { toast.error(e.response?.data?.error || 'Error'); }
  };

  return (
    <div className="card overflow-hidden">
      <div
        className="flex items-center justify-between p-4 cursor-pointer"
        onClick={() => hasVariants && setOpen(o => !o)}
      >
        <div className="flex items-center gap-3 flex-1 min-w-0">
          {hasVariants && (
            open ? <ChevronDown size={16} className="text-gray-400 shrink-0" />
                 : <ChevronRight size={16} className="text-gray-400 shrink-0" />
          )}
          <div className="min-w-0">
            <div className="flex items-center gap-2 flex-wrap">
              <span className="font-semibold text-gray-900 dark:text-white text-sm">{product.name}</span>
              {pending && !hasVariants && <span className="badge-pending text-xs">Pendiente de configurar</span>}
              {hasVariants && pendingVariants > 0 && (
                <span className="badge-pending text-xs">{pendingVariants} variante{pendingVariants !== 1 ? 's' : ''} pendiente{pendingVariants !== 1 ? 's' : ''}</span>
              )}
            </div>
            {product.sku && <span className="text-xs text-gray-400">{product.sku}</span>}
          </div>
        </div>

        <div className="flex items-center gap-3 shrink-0 ml-2" onClick={e => e.stopPropagation()}>
          {!hasVariants && (
            editingPrice ? (
              <PriceEditor value={product.sale_price} onSave={savePrice} onCancel={() => setEditingPrice(false)} />
            ) : (
              <button onClick={() => setEditingPrice(true)} className="flex items-center gap-1 text-gray-500 hover:text-gray-700">
                <span className="font-semibold text-sm">{product.sale_price > 0 ? `S/ ${product.sale_price}` : '—'}</span>
                <Edit size={12} />
              </button>
            )
          )}
          <button
            onClick={toggleActive}
            className={`text-xs px-2 py-0.5 rounded-full font-medium border transition-colors
              ${product.active
                ? 'bg-green-100 text-green-700 border-green-200 dark:bg-green-900/30 dark:text-green-400'
                : 'bg-gray-100 text-gray-500 border-gray-200 dark:bg-gray-800 dark:text-gray-500'}`}
          >
            {product.active ? 'Activo' : 'Inactivo'}
          </button>
        </div>
      </div>

      {open && hasVariants && (
        <div className="px-4 pb-4 space-y-2 border-t border-gray-100 dark:border-gray-800 pt-3">
          {product.variants.map(v => (
            <VariantRow key={v.id} variant={v} onUpdate={onUpdate} />
          ))}
        </div>
      )}
    </div>
  );
}

export default function Catalog() {
  const [products, setProducts] = useState([]);
  const [loading, setLoading] = useState(true);

  const load = () => {
    setLoading(true);
    catalogApi.list()
      .then(setProducts)
      .catch(() => toast.error('Error al cargar catálogo'))
      .finally(() => setLoading(false));
  };

  useEffect(load, []);

  const grouped = products.reduce((acc, p) => {
    const cat = p.category || 'otro';
    if (!acc[cat]) acc[cat] = [];
    acc[cat].push(p);
    return acc;
  }, {});

  return (
    <div className="p-4 space-y-6">
      <div className="flex items-center gap-3">
        <Package size={22} className="text-orange-500" />
        <h1 className="text-xl font-bold text-gray-900 dark:text-white">Catálogo de productos</h1>
      </div>

      {loading ? (
        <div className="flex items-center justify-center h-40 text-gray-400">Cargando...</div>
      ) : (
        Object.entries(grouped).map(([cat, prods]) => (
          <div key={cat}>
            <h2 className="font-semibold text-gray-500 dark:text-gray-400 text-xs uppercase tracking-wider mb-2">
              {CATEGORY_LABELS[cat] || cat}
            </h2>
            <div className="space-y-2">
              {prods.map(p => (
                <ProductCard key={p.id} product={p} onUpdate={load} />
              ))}
            </div>
          </div>
        ))
      )}
      <div className="h-4" />
    </div>
  );
}
