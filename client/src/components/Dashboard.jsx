import React, { useState, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { dashboard } from '../api.js';
import {
  TrendingUp, TrendingDown, Package, DollarSign,
  Clock, AlertTriangle, Star, RefreshCw, Plus
} from 'lucide-react';
import toast from 'react-hot-toast';

function StatCard({ icon: Icon, label, value, sub, color = 'orange', onClick }) {
  const colors = {
    orange: 'bg-orange-50 dark:bg-orange-900/20 text-orange-600 dark:text-orange-400',
    blue:   'bg-blue-50 dark:bg-blue-900/20 text-blue-700 dark:text-blue-400',
    green:  'bg-green-50 dark:bg-green-900/20 text-green-700 dark:text-green-400',
    red:    'bg-red-50 dark:bg-red-900/20 text-red-700 dark:text-red-400',
  };
  return (
    <div
      className={`card p-4 ${onClick ? 'cursor-pointer active:scale-95 transition-transform' : ''}`}
      onClick={onClick}
    >
      <div className={`inline-flex p-2 rounded-xl mb-3 ${colors[color]}`}>
        <Icon size={20} />
      </div>
      <div className="text-2xl font-bold text-gray-900 dark:text-white">{value}</div>
      <div className="text-sm text-gray-500 dark:text-gray-400 mt-0.5">{label}</div>
      {sub && <div className="text-xs text-gray-400 dark:text-gray-500 mt-1">{sub}</div>}
    </div>
  );
}

export default function Dashboard() {
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const nav = useNavigate();

  const load = async () => {
    setLoading(true);
    try {
      const d = await dashboard.get();
      setData(d);
      if (d.balloonsToday >= d.goal) {
        toast.success(`🎉 ¡Meta diaria de ${d.goal} balones alcanzada!`, { duration: 5000 });
      }
    } catch { toast.error('Error cargando datos'); }
    finally { setLoading(false); }
  };

  useEffect(() => { load(); }, []);

  if (loading) return (
    <div className="flex items-center justify-center h-64">
      <div className="text-center">
        <div className="text-4xl mb-3 animate-spin">🔥</div>
        <p className="text-gray-500">Cargando...</p>
      </div>
    </div>
  );

  if (!data) return null;

  const goalPct = Math.min(100, Math.round((data.balloonsToday / data.goal) * 100));
  const today = new Date().toLocaleDateString('es-PE', { weekday:'long', day:'numeric', month:'long' });
  const diffBalloons = data.balloonsToday - data.balloonsLastWeek;
  const diffRevenue  = data.revenueToday - data.revenueLastWeek;

  return (
    <div className="p-4 space-y-4">
      {/* Date + refresh */}
      <div className="flex items-center justify-between">
        <p className="text-sm text-gray-500 dark:text-gray-400 capitalize">{today}</p>
        <button onClick={load} className="btn-ghost !py-2 !px-3 flex items-center gap-1.5 text-sm">
          <RefreshCw size={14} /> Actualizar
        </button>
      </div>

      {/* Meta diaria */}
      <div className="card p-5">
        <div className="flex items-center justify-between mb-3">
          <div>
            <p className="text-sm font-medium text-gray-500 dark:text-gray-400">Balones vendidos hoy</p>
            <p className="text-4xl font-bold text-gray-900 dark:text-white mt-1">
              {data.balloonsToday}
              <span className="text-lg font-normal text-gray-400 ml-2">/ {data.goal}</span>
            </p>
          </div>
          <div className={`text-5xl font-black ${goalPct >= 100 ? 'text-green-500' : 'text-orange-500'}`}>
            {goalPct}%
          </div>
        </div>
        {/* Progress bar */}
        <div className="w-full bg-gray-200 dark:bg-gray-700 rounded-full h-4 overflow-hidden">
          <div
            className={`h-4 rounded-full transition-all duration-700 ${goalPct >= 100 ? 'bg-green-500' : goalPct >= 50 ? 'bg-orange-500' : 'bg-blue-500'}`}
            style={{ width: `${goalPct}%` }}
          />
        </div>
        <div className="flex justify-between text-xs text-gray-400 mt-1.5">
          <span>0</span>
          <span className={goalPct >= 100 ? 'text-green-500 font-semibold' : ''}>
            {goalPct >= 100 ? '🎉 ¡Meta lograda!' : `Faltan ${data.goal - data.balloonsToday} balones`}
          </span>
          <span>{data.goal}</span>
        </div>
        {/* Breakdown */}
        <div className="flex gap-4 mt-3 text-sm text-gray-500 dark:text-gray-400">
          <span>🟡 10kg: <strong className="text-gray-700 dark:text-gray-200">{data.breakdown.balloons_10}</strong></span>
          <span>🔴 40kg: <strong className="text-gray-700 dark:text-gray-200">{data.breakdown.balloons_40}</strong></span>
        </div>
      </div>

      {/* Tarjetas de stats */}
      <div className="grid grid-cols-2 gap-3">
        <StatCard
          icon={DollarSign} color="green" label="Ingresos hoy"
          value={`S/ ${data.revenueToday.toFixed(0)}`}
          sub={diffRevenue >= 0
            ? `▲ S/ ${Math.abs(diffRevenue).toFixed(0)} vs sem. anterior`
            : `▼ S/ ${Math.abs(diffRevenue).toFixed(0)} vs sem. anterior`}
        />
        <StatCard
          icon={Clock} color="orange" label="Pedidos pendientes"
          value={data.pendingOrders}
          sub="Haz clic para ver"
          onClick={() => nav('/orders')}
        />
        <StatCard
          icon={Package} color="blue" label="Pedidos del día"
          value={data.todayOrders}
          onClick={() => nav('/orders')}
        />
        <StatCard
          icon={diffBalloons >= 0 ? TrendingUp : TrendingDown}
          color={diffBalloons >= 0 ? 'green' : 'red'}
          label="Semana anterior"
          value={data.balloonsLastWeek}
          sub={`${diffBalloons >= 0 ? '+' : ''}${diffBalloons} balones`}
        />
      </div>

      {/* Acción rápida */}
      <button
        onClick={() => nav('/orders/new')}
        className="btn-primary w-full text-base py-4 flex items-center justify-center gap-2"
      >
        <Plus size={20} /> Nuevo Pedido
      </button>

      {/* Alertas de deuda */}
      {data.highDebts.length > 0 && (
        <div className="card p-4 border-l-4 border-red-400">
          <h3 className="font-bold text-red-600 dark:text-red-400 flex items-center gap-2 mb-3">
            <AlertTriangle size={18} /> Deudas pendientes ({data.highDebts.length})
          </h3>
          <div className="space-y-2">
            {data.highDebts.map(c => (
              <div
                key={c.id}
                className="flex items-center justify-between cursor-pointer hover:bg-red-50 dark:hover:bg-red-900/10 rounded-lg p-2 -mx-2"
                onClick={() => nav(`/clients/${c.id}`)}
              >
                <span className="font-medium text-sm text-gray-800 dark:text-gray-200">{c.name}</span>
                <span className="font-bold text-red-600 dark:text-red-400">S/ {c.debt.toFixed(0)}</span>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Clientes inactivos */}
      {data.inactiveClients.length > 0 && (
        <div className="card p-4 border-l-4 border-yellow-400">
          <h3 className="font-bold text-yellow-600 dark:text-yellow-400 flex items-center gap-2 mb-3">
            <Star size={18} /> Clientes a reactivar ({data.inactiveClients.length})
          </h3>
          <div className="space-y-2">
            {data.inactiveClients.slice(0, 8).map(c => (
              <div
                key={c.id}
                className="flex items-center justify-between cursor-pointer hover:bg-yellow-50 dark:hover:bg-yellow-900/10 rounded-lg p-2 -mx-2"
                onClick={() => nav(`/clients/${c.id}`)}
              >
                <div className="flex items-center gap-2">
                  {c.is_vip ? <Star size={14} className="text-yellow-500 fill-yellow-500" /> : <span className="w-3.5" />}
                  <span className="font-medium text-sm text-gray-800 dark:text-gray-200">{c.name}</span>
                </div>
                <span className="text-xs text-gray-400">
                  {c.last_order
                    ? `Hace ${Math.floor((Date.now() - new Date(c.last_order)) / 86400000)}d`
                    : 'Nunca'}
                </span>
              </div>
            ))}
          </div>
        </div>
      )}

      <div className="h-4" />
    </div>
  );
}
