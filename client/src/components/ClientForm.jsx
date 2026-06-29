import React, { useState, useEffect } from 'react';
import { useParams, useNavigate, useSearchParams } from 'react-router-dom';
import { clients } from '../api.js';
import { useApp } from '../App.jsx';
import { ChevronLeft, Save } from 'lucide-react';
import toast from 'react-hot-toast';

const DEFAULT_ZONES = 'San Borja,Surco,Surquillo,Miraflores,San Luis,San Isidro,Otra';

const EMPTY = {
  name: '', address: '', reference: '', zone: 'San Borja', phone: '',
  type: 'Residencial', business_type: '', preferred_balloon: '10kg',
  purchase_frequency: 'semanal', notes: '', is_vip: false, debt: 0,
};

export default function ClientForm() {
  const { id } = useParams();
  const nav = useNavigate();
  const [sp] = useSearchParams();
  const isEdit = Boolean(id);
  const [form, setForm] = useState({ ...EMPTY, name: sp.get('name') || '' });
  const [saving, setSaving] = useState(false);
  const { cfg } = useApp();

  // Zonas configurables desde Config; incluye la zona actual del cliente por si
  // ya no está en la lista (clientes antiguos).
  const zones = (() => {
    const list = (cfg?.zones || DEFAULT_ZONES).split(',').map(s => s.trim()).filter(Boolean);
    if (form.zone && !list.includes(form.zone)) list.push(form.zone);
    return list;
  })();

  useEffect(() => {
    if (isEdit) clients.get(id).then(c => setForm({ ...c, is_vip: Boolean(c.is_vip) }));
  }, [id]);

  const set = (k, v) => setForm(f => ({ ...f, [k]: v }));

  const submit = async (e) => {
    e.preventDefault();
    if (!form.name.trim()) return toast.error('El nombre es obligatorio');
    setSaving(true);
    try {
      if (isEdit) { await clients.update(id, form); toast.success('Cliente actualizado'); nav(`/clients/${id}`); }
      else { const { id: newId } = await clients.create(form); toast.success('Cliente creado'); nav(`/clients/${newId}`); }
    } catch { toast.error('Error al guardar'); }
    finally { setSaving(false); }
  };

  return (
    <form onSubmit={submit} className="p-4 space-y-4">
      <button type="button" onClick={() => nav(-1)} className="flex items-center gap-1 text-blue-700 dark:text-blue-400 font-medium -ml-1">
        <ChevronLeft size={20} /> {isEdit ? 'Volver' : 'Clientes'}
      </button>

      <h2 className="text-xl font-bold text-gray-900 dark:text-white">
        {isEdit ? 'Editar cliente' : 'Nuevo cliente'}
      </h2>

      <div className="card p-4 space-y-4">
        <div>
          <label className="label">Nombre completo *</label>
          <input className="input" value={form.name} onChange={e => set('name', e.target.value)} placeholder="Ej: Rosa Flores" />
        </div>
        <div>
          <label className="label">Teléfono / WhatsApp</label>
          <input className="input" type="tel" value={form.phone} onChange={e => set('phone', e.target.value)} placeholder="987654321" />
        </div>
        <div>
          <label className="label">Dirección</label>
          <input className="input" value={form.address} onChange={e => set('address', e.target.value)} placeholder="Av. San Borja Norte 450" />
        </div>
        <div>
          <label className="label">Referencia</label>
          <input className="input" value={form.reference} onChange={e => set('reference', e.target.value)} placeholder="Frente al parque, piso 2..." />
        </div>
        <div>
          <label className="label">Zona</label>
          <select className="input" value={form.zone} onChange={e => set('zone', e.target.value)}>
            {zones.map(z => <option key={z}>{z}</option>)}
          </select>
        </div>
      </div>

      <div className="card p-4 space-y-4">
        <div>
          <label className="label">Tipo de cliente</label>
          <div className="flex gap-2">
            {['Residencial','Negocio'].map(t => (
              <button key={t} type="button"
                onClick={() => set('type', t)}
                className={`flex-1 py-2.5 rounded-xl font-medium transition-colors
                  ${form.type === t ? 'bg-blue-900 text-white' : 'bg-gray-100 dark:bg-gray-700 text-gray-600 dark:text-gray-300'}`}>
                {t}
              </button>
            ))}
          </div>
        </div>
        {form.type === 'Negocio' && (
          <div>
            <label className="label">Tipo de negocio</label>
            <select className="input" value={form.business_type} onChange={e => set('business_type', e.target.value)}>
              <option value="">Seleccionar...</option>
              {['restaurante','panadería','lavandería','mercado','otro'].map(b => <option key={b}>{b}</option>)}
            </select>
          </div>
        )}
        <div>
          <label className="label">Balón preferido</label>
          <div className="flex gap-2">
            {['10kg','40kg','Ambos'].map(b => (
              <button key={b} type="button"
                onClick={() => set('preferred_balloon', b)}
                className={`flex-1 py-2.5 rounded-xl font-medium transition-colors
                  ${form.preferred_balloon === b ? 'bg-orange-500 text-white' : 'bg-gray-100 dark:bg-gray-700 text-gray-600 dark:text-gray-300'}`}>
                {b}
              </button>
            ))}
          </div>
        </div>
        <div>
          <label className="label">Frecuencia de compra</label>
          <select className="input" value={form.purchase_frequency} onChange={e => set('purchase_frequency', e.target.value)}>
            {['diaria','semanal','quincenal','mensual','irregular'].map(f => <option key={f}>{f}</option>)}
          </select>
        </div>
        <div className="flex items-center justify-between">
          <div>
            <p className="font-semibold text-gray-700 dark:text-gray-300">Cliente VIP ⭐</p>
            <p className="text-xs text-gray-400">Aparece destacado en alertas</p>
          </div>
          <button type="button"
            onClick={() => set('is_vip', !form.is_vip)}
            className={`relative w-12 h-6 rounded-full transition-colors ${form.is_vip ? 'bg-yellow-400' : 'bg-gray-300 dark:bg-gray-600'}`}>
            <span className={`absolute top-0.5 w-5 h-5 bg-white rounded-full shadow transition-transform ${form.is_vip ? 'translate-x-6' : 'translate-x-0.5'}`} />
          </button>
        </div>
        {isEdit && (
          <div>
            <label className="label">Deuda pendiente (S/)</label>
            <input className="input" type="number" min="0" step="0.01" value={form.debt} onChange={e => set('debt', parseFloat(e.target.value) || 0)} />
          </div>
        )}
        <div>
          <label className="label">Notas</label>
          <textarea className="input resize-none" rows={3} value={form.notes} onChange={e => set('notes', e.target.value)} placeholder="Información adicional..." />
        </div>
      </div>

      <button type="submit" disabled={saving} className="btn-primary w-full flex items-center justify-center gap-2 py-4 text-base">
        <Save size={18} /> {saving ? 'Guardando...' : isEdit ? 'Guardar cambios' : 'Crear cliente'}
      </button>
      <div className="h-4" />
    </form>
  );
}
