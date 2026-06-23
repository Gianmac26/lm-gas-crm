import React, { useState, useEffect } from 'react';
import { riders } from '../api.js';
import { Truck, Phone, Plus, Edit, Check, X } from 'lucide-react';
import toast from 'react-hot-toast';

const EMPTY = { name: '', phone: '', zone: 'San Borja' };

export default function Riders() {
  const [list, setList]       = useState([]);
  const [loading, setLoading] = useState(true);
  const [editing, setEditing] = useState(null); // { id?, ...fields }
  const [showForm, setShowForm] = useState(false);

  const load = () => riders.list().then(setList).finally(() => setLoading(false));
  useEffect(() => { load(); }, []);

  const save = async () => {
    if (!editing.name.trim()) return toast.error('El nombre es obligatorio');
    try {
      if (editing.id) await riders.update(editing.id, editing);
      else await riders.create(editing);
      toast.success(editing.id ? 'Motorizado actualizado' : 'Motorizado creado');
      setEditing(null); setShowForm(false); load();
    } catch { toast.error('Error al guardar'); }
  };

  const toggle = async (rider) => {
    await riders.update(rider.id, { ...rider, active: rider.active ? 0 : 1 });
    load();
  };

  return (
    <div className="p-4 space-y-4">
      <div className="flex items-center justify-between">
        <p className="text-sm text-gray-500 dark:text-gray-400">{list.length} motorizados</p>
        <button onClick={() => { setEditing({ ...EMPTY }); setShowForm(true); }}
          className="btn-primary !py-2 !px-4 flex items-center gap-1.5 text-sm">
          <Plus size={16} /> Agregar
        </button>
      </div>

      {/* Add/Edit form */}
      {(showForm || editing?.id) && editing && (
        <div className="card p-4 space-y-3 border-2 border-orange-300">
          <h3 className="font-bold text-gray-800 dark:text-gray-200">
            {editing.id ? 'Editar motorizado' : 'Nuevo motorizado'}
          </h3>
          <div>
            <label className="label">Nombre</label>
            <input className="input" value={editing.name} onChange={e => setEditing(p => ({ ...p, name: e.target.value }))} placeholder="Juan Pérez" />
          </div>
          <div>
            <label className="label">Teléfono</label>
            <input className="input" type="tel" value={editing.phone} onChange={e => setEditing(p => ({ ...p, phone: e.target.value }))} placeholder="987654321" />
          </div>
          <div>
            <label className="label">Zona asignada</label>
            <select className="input" value={editing.zone} onChange={e => setEditing(p => ({ ...p, zone: e.target.value }))}>
              {['San Borja','Surco','Miraflores','Toda Lima','Otra'].map(z => <option key={z}>{z}</option>)}
            </select>
          </div>
          <div className="flex gap-2">
            <button onClick={save} className="btn-primary flex-1 flex items-center justify-center gap-2">
              <Check size={16} /> Guardar
            </button>
            <button onClick={() => { setEditing(null); setShowForm(false); }} className="btn-ghost flex-1 flex items-center justify-center gap-2">
              <X size={16} /> Cancelar
            </button>
          </div>
        </div>
      )}

      {loading ? (
        <div className="space-y-3">
          {[1,2,3].map(i => <div key={i} className="card h-32 animate-pulse bg-gray-100 dark:bg-gray-800" />)}
        </div>
      ) : (
        <div className="space-y-3">
          {list.map(r => (
            <div key={r.id} className={`card p-4 ${!r.active ? 'opacity-50' : ''}`}>
              <div className="flex items-start justify-between">
                <div className="flex items-center gap-3">
                  <div className="w-12 h-12 rounded-xl bg-blue-100 dark:bg-blue-900/40 flex items-center justify-center">
                    <Truck size={22} className="text-blue-700 dark:text-blue-400" />
                  </div>
                  <div>
                    <h3 className="font-bold text-gray-900 dark:text-white">{r.name}</h3>
                    <p className="text-sm text-gray-500 dark:text-gray-400">📍 {r.zone}</p>
                    {r.phone && (
                      <a href={`tel:${r.phone}`} className="text-sm text-blue-600 flex items-center gap-1 mt-0.5">
                        <Phone size={12} /> {r.phone}
                      </a>
                    )}
                  </div>
                </div>
                <div className="flex gap-2">
                  <button onClick={() => { setEditing({ ...r }); setShowForm(false); }} className="btn-ghost !py-1.5 !px-2.5">
                    <Edit size={14} />
                  </button>
                  <button onClick={() => toggle(r)}
                    className={`text-xs px-3 py-1.5 rounded-xl font-medium ${r.active ? 'bg-green-100 text-green-700' : 'bg-gray-100 text-gray-500'}`}>
                    {r.active ? 'Activo' : 'Inactivo'}
                  </button>
                </div>
              </div>

              {/* Today's stats */}
              <div className="grid grid-cols-3 gap-2 mt-4 pt-4 border-t border-gray-100 dark:border-gray-700">
                <div className="text-center">
                  <div className="text-xl font-bold text-gray-900 dark:text-white">{r.todayOrders}</div>
                  <div className="text-xs text-gray-500">Pedidos hoy</div>
                </div>
                <div className="text-center">
                  <div className="text-xl font-bold text-green-600">{r.delivered}</div>
                  <div className="text-xs text-gray-500">Entregados</div>
                </div>
                <div className="text-center">
                  <div className="text-xl font-bold text-blue-600">{r.weekBalloons}</div>
                  <div className="text-xs text-gray-500">Balones semana</div>
                </div>
              </div>

              {/* WhatsApp */}
              {r.phone && (
                <a href={`https://wa.me/51${r.phone}`} target="_blank" rel="noopener noreferrer"
                  className="mt-3 w-full flex items-center justify-center gap-2 bg-green-500 text-white rounded-xl py-2.5 text-sm font-semibold">
                  📱 WhatsApp
                </a>
              )}
            </div>
          ))}
        </div>
      )}
      <div className="h-4" />
    </div>
  );
}
