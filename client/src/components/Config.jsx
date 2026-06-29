import React, { useState, useEffect } from 'react';
import { config } from '../api.js';
import { Save, Moon, Sun, LogOut, Eye, EyeOff } from 'lucide-react';
import { useApp } from '../App.jsx';
import toast from 'react-hot-toast';

export default function Config() {
  const { toggleDark, darkMode } = useApp();
  const [form, setForm] = useState({
    pin: '', pin_confirm: '',
    daily_goal: '80',
    price_10kg: '38', price_45kg: '120',
    price_water: '12', price_cleaning: '15',
    zones: 'San Borja,Surco,Surquillo,Miraflores,San Luis,San Isidro,Otra',
  });
  const [showPin, setShowPin] = useState(false);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    config.get().then(c => setForm(f => ({
      ...f,
      daily_goal:    c.daily_goal    || '80',
      price_10kg:    c.price_10kg    || '38',
      price_45kg:    c.price_45kg    || c.price_40kg || '120',
      price_water:   c.price_water   || '12',
      price_cleaning:c.price_cleaning|| '15',
      zones:         c.zones         || 'San Borja,Surco,Surquillo,Miraflores,San Luis,San Isidro,Otra',
    })));
  }, []);

  const set = (k, v) => setForm(f => ({ ...f, [k]: v }));

  const save = async () => {
    if (form.pin && form.pin !== form.pin_confirm) return toast.error('Los PINs no coinciden');
    if (form.pin && form.pin.length !== 4) return toast.error('El PIN debe tener 4 dígitos');
    setSaving(true);
    try {
      const payload = {
        daily_goal:     form.daily_goal,
        price_10kg:     form.price_10kg,
        price_45kg:     form.price_45kg,
        price_water:    form.price_water,
        price_cleaning: form.price_cleaning,
        zones:          form.zones,
      };
      if (form.pin) payload.pin = form.pin;
      await config.update(payload);
      toast.success('Configuración guardada');
      setForm(f => ({ ...f, pin: '', pin_confirm: '' }));
    } catch { toast.error('Error al guardar'); }
    finally { setSaving(false); }
  };

  const logout = () => {
    sessionStorage.removeItem('lm_auth');
    window.location.reload();
  };

  return (
    <div className="p-4 space-y-4">

      {/* Precios */}
      <div className="card p-4 space-y-3">
        <h2 className="font-bold text-gray-800 dark:text-gray-200 text-base">💰 Precios (S/)</h2>
        {[
          { key: 'price_10kg',     label: 'Balón 10 kg (default)' },
          { key: 'price_45kg',     label: 'Balón 45 kg (Solgas)' },
          { key: 'price_water',    label: 'Agua bidón 20L' },
          { key: 'price_cleaning', label: 'Artículo limpieza (base)' },
        ].map(({ key, label }) => (
          <div key={key} className="flex items-center justify-between gap-3">
            <label className="text-sm font-medium text-gray-700 dark:text-gray-300 flex-1">{label}</label>
            <div className="flex items-center gap-1 w-28">
              <span className="text-gray-400 font-medium">S/</span>
              <input
                className="input !py-2 text-center w-20"
                type="number" min="0" step="0.50"
                value={form[key]}
                onChange={e => set(key, e.target.value)}
              />
            </div>
          </div>
        ))}
      </div>

      {/* Meta diaria */}
      <div className="card p-4 space-y-3">
        <h2 className="font-bold text-gray-800 dark:text-gray-200 text-base">🎯 Meta diaria</h2>
        <div className="flex items-center justify-between gap-3">
          <label className="text-sm font-medium text-gray-700 dark:text-gray-300">Balones por día</label>
          <div className="flex items-center gap-2">
            <button onClick={() => set('daily_goal', String(Math.max(1, parseInt(form.daily_goal) - 10)))}
              className="w-10 h-10 rounded-xl bg-gray-100 dark:bg-gray-700 font-bold text-lg">−</button>
            <span className="text-2xl font-bold text-blue-900 dark:text-blue-300 w-14 text-center">{form.daily_goal}</span>
            <button onClick={() => set('daily_goal', String(parseInt(form.daily_goal) + 10))}
              className="w-10 h-10 rounded-xl bg-gray-100 dark:bg-gray-700 font-bold text-lg">+</button>
          </div>
        </div>
      </div>

      {/* Zonas */}
      <div className="card p-4 space-y-3">
        <h2 className="font-bold text-gray-800 dark:text-gray-200 text-base">📍 Zonas de cobertura</h2>
        <div>
          <label className="label">Zonas (separadas por coma)</label>
          <input className="input" value={form.zones} onChange={e => set('zones', e.target.value)} placeholder="San Borja,Surco,Miraflores,Otra" />
          <p className="text-xs text-gray-400 mt-1">Ej: San Borja, Surco, Miraflores, Otra</p>
        </div>
      </div>

      {/* PIN */}
      <div className="card p-4 space-y-3">
        <h2 className="font-bold text-gray-800 dark:text-gray-200 text-base">🔒 Cambiar PIN</h2>
        <div>
          <label className="label">Nuevo PIN (4 dígitos)</label>
          <div className="relative">
            <input
              className="input pr-10"
              type={showPin ? 'text' : 'password'}
              inputMode="numeric"
              maxLength={4}
              placeholder="Dejar vacío para no cambiar"
              value={form.pin}
              onChange={e => set('pin', e.target.value.replace(/\D/g, '').slice(0, 4))}
            />
            <button type="button" onClick={() => setShowPin(p => !p)}
              className="absolute right-3 top-1/2 -translate-y-1/2 text-gray-400">
              {showPin ? <EyeOff size={18} /> : <Eye size={18} />}
            </button>
          </div>
        </div>
        {form.pin && (
          <div>
            <label className="label">Confirmar nuevo PIN</label>
            <input className="input" type={showPin ? 'text' : 'password'} inputMode="numeric" maxLength={4}
              value={form.pin_confirm} onChange={e => set('pin_confirm', e.target.value.replace(/\D/g, '').slice(0, 4))} />
          </div>
        )}
      </div>

      {/* Appearance */}
      <div className="card p-4">
        <div className="flex items-center justify-between">
          <div>
            <p className="font-semibold text-gray-800 dark:text-gray-200">Modo oscuro</p>
            <p className="text-xs text-gray-400">Mejor para usar de noche</p>
          </div>
          <button onClick={toggleDark}
            className={`flex items-center gap-2 px-4 py-2.5 rounded-xl font-medium text-sm transition-colors
              ${darkMode ? 'bg-blue-900 text-white' : 'bg-yellow-100 text-yellow-700'}`}>
            {darkMode ? <Moon size={16} /> : <Sun size={16} />}
            {darkMode ? 'Oscuro' : 'Claro'}
          </button>
        </div>
      </div>

      {/* Save */}
      <button onClick={save} disabled={saving} className="btn-primary w-full flex items-center justify-center gap-2 py-4 text-base">
        <Save size={18} /> {saving ? 'Guardando...' : 'Guardar configuración'}
      </button>

      {/* App info */}
      <div className="card p-4 text-center">
        <div className="text-3xl mb-2">🔥</div>
        <p className="font-bold text-gray-800 dark:text-gray-200">L&M Gas CRM</p>
        <p className="text-xs text-gray-400 mt-1">v1.0.0 · Distribuidora de Gas · Lima, Perú</p>
      </div>

      {/* Logout */}
      <button onClick={logout}
        className="w-full flex items-center justify-center gap-2 text-red-500 py-3 font-medium border border-red-200 dark:border-red-800 rounded-xl">
        <LogOut size={16} /> Cerrar sesión
      </button>

      <div className="h-4" />
    </div>
  );
}
