import React, { useState, useEffect } from 'react';
import { reports } from '../api.js';
import { Download, TrendingUp, Users, MapPin, Package, Truck, AlertTriangle } from 'lucide-react';
import toast from 'react-hot-toast';

function fmt(n)    { return `S/ ${(n||0).toFixed(0)}`; }
function fmtD(n)   { return (n||0).toFixed(0); }
function pct(a, b) { if (!b) return '—'; return `${((a/b)*100).toFixed(0)}%`; }

const PERIODS = [
  { label: 'Hoy',        from: 0,  to: 0 },
  { label: 'Esta semana',from: 6,  to: 0 },
  { label: 'Este mes',   from: 29, to: 0 },
];

function dateRange(daysFrom, daysTo = 0) {
  const f = new Date(); f.setDate(f.getDate() - daysFrom);
  const t = new Date(); t.setDate(t.getDate() - daysTo);
  return { from: f.toISOString().slice(0,10), to: t.toISOString().slice(0,10) };
}

export default function Reports() {
  const [tab, setTab]           = useState('ventas');
  const [period, setPeriod]     = useState(1); // this week
  const [inactiveDays, setInactiveDays] = useState(7);
  const [sales, setSales]       = useState([]);
  const [byZone, setByZone]     = useState([]);
  const [byProduct, setByProduct] = useState([]);
  const [byRider, setByRider]   = useState([]);
  const [topClients, setTopClients] = useState([]);
  const [inactive, setInactive] = useState([]);
  const [debts, setDebts]       = useState([]);
  const [avgTicket, setAvgTicket] = useState({});
  const [loading, setLoading]   = useState(false);

  const range = dateRange(PERIODS[period].from, PERIODS[period].to);

  const loadAll = async () => {
    setLoading(true);
    try {
      const params = range;
      const [s, z, p, r, tc, i, d, a] = await Promise.all([
        reports.sales({ ...params, group_by: PERIODS[period].from >= 29 ? 'day' : 'day' }),
        reports.byZone(params),
        reports.byProduct(params),
        reports.byRider(params),
        reports.topClients(params),
        reports.inactive({ days: inactiveDays }),
        reports.debts(),
        reports.avgTicket(params),
      ]);
      setSales(s); setByZone(z); setByProduct(p); setByRider(r);
      setTopClients(tc); setInactive(i); setDebts(d); setAvgTicket(a);
    } catch { toast.error('Error cargando reportes'); }
    finally { setLoading(false); }
  };

  useEffect(() => { loadAll(); }, [period, inactiveDays]);

  const totalRevenue  = sales.reduce((s, d) => s + d.revenue, 0);
  const totalBalloons = sales.reduce((s, d) => s + d.balloons_10 + d.balloons_40, 0);
  const totalOrders   = sales.reduce((s, d) => s + d.orders, 0);

  const exportInactive = () => {
    window.open(reports.exportInactive(inactiveDays), '_blank');
    toast.success('Descargando Excel...');
  };

  const TABS = [
    { id: 'ventas',    label: 'Ventas',    icon: TrendingUp },
    { id: 'zonas',     label: 'Zonas',     icon: MapPin },
    { id: 'productos', label: 'Productos', icon: Package },
    { id: 'motos',     label: 'Moto',      icon: Truck },
    { id: 'clientes',  label: 'Clientes',  icon: Users },
    { id: 'deudas',    label: 'Deudas',    icon: AlertTriangle },
  ];

  return (
    <div className="p-4 space-y-4">
      {/* Period selector */}
      <div className="flex gap-2">
        {PERIODS.map((p, i) => (
          <button key={i} onClick={() => setPeriod(i)}
            className={`flex-1 py-2.5 rounded-xl text-sm font-medium transition-colors
              ${period === i ? 'bg-blue-900 text-white' : 'bg-gray-100 dark:bg-gray-800 text-gray-600 dark:text-gray-300'}`}>
            {p.label}
          </button>
        ))}
      </div>

      {/* Summary cards */}
      <div className="grid grid-cols-3 gap-2">
        <div className="card p-3 text-center">
          <div className="text-xl font-bold text-orange-500">{fmt(totalRevenue)}</div>
          <div className="text-xs text-gray-500 mt-0.5">Ingresos</div>
        </div>
        <div className="card p-3 text-center">
          <div className="text-xl font-bold text-blue-700 dark:text-blue-400">{totalBalloons}</div>
          <div className="text-xs text-gray-500 mt-0.5">Balones</div>
        </div>
        <div className="card p-3 text-center">
          <div className="text-xl font-bold text-gray-900 dark:text-white">{fmt(avgTicket.avg_ticket)}</div>
          <div className="text-xs text-gray-500 mt-0.5">Ticket prom.</div>
        </div>
      </div>

      {/* Tabs */}
      <div className="flex gap-1 overflow-x-auto no-scrollbar bg-gray-100 dark:bg-gray-800 p-1 rounded-xl">
        {TABS.map(({ id, label, icon: Icon }) => (
          <button key={id} onClick={() => setTab(id)}
            className={`flex-shrink-0 flex items-center gap-1.5 px-3 py-2 rounded-lg text-sm font-medium transition-colors
              ${tab === id ? 'bg-white dark:bg-gray-700 text-blue-900 dark:text-white shadow-sm' : 'text-gray-500 dark:text-gray-400'}`}>
            <Icon size={14} /> {label}
          </button>
        ))}
      </div>

      {loading ? (
        <div className="card h-40 animate-pulse bg-gray-100 dark:bg-gray-800" />
      ) : (
        <>
          {/* VENTAS */}
          {tab === 'ventas' && (
            <div className="space-y-2">
              {sales.length === 0 ? (
                <div className="card p-6 text-center text-gray-400">Sin ventas en este período</div>
              ) : sales.map((d, i) => (
                <div key={i} className="card p-3 flex items-center justify-between">
                  <div>
                    <p className="font-semibold text-gray-800 dark:text-gray-200 text-sm">{d.period}</p>
                    <p className="text-xs text-gray-400">{d.orders} pedidos · {d.balloons_10 + d.balloons_40} balones</p>
                  </div>
                  <span className="font-bold text-orange-500">{fmt(d.revenue)}</span>
                </div>
              ))}
            </div>
          )}

          {/* ZONAS */}
          {tab === 'zonas' && (
            <div className="space-y-2">
              {byZone.map((z, i) => (
                <div key={i} className="card p-4">
                  <div className="flex justify-between items-start">
                    <div>
                      <p className="font-bold text-gray-900 dark:text-white">{z.zone || 'Sin zona'}</p>
                      <p className="text-sm text-gray-500">{z.orders} pedidos · {z.balloons} balones</p>
                    </div>
                    <span className="font-bold text-orange-500 text-lg">{fmt(z.revenue)}</span>
                  </div>
                  {/* Mini bar */}
                  <div className="mt-2 h-2 bg-gray-200 dark:bg-gray-700 rounded-full overflow-hidden">
                    <div className="h-2 bg-orange-400 rounded-full"
                      style={{ width: pct(z.revenue, byZone.reduce((s, x) => s + x.revenue, 0)) }} />
                  </div>
                </div>
              ))}
            </div>
          )}

          {/* PRODUCTOS */}
          {tab === 'productos' && (
            <div className="space-y-2">
              {byProduct.map((p, i) => (
                <div key={i} className="card p-4 flex items-center justify-between">
                  <div>
                    <p className="font-bold text-gray-900 dark:text-white">{p.product}</p>
                    <p className="text-sm text-gray-500">{p.quantity} unidades · Precio prom: {fmt(p.avg_price)}</p>
                  </div>
                  <span className="font-bold text-orange-500">{fmt(p.revenue)}</span>
                </div>
              ))}
            </div>
          )}

          {/* MOTORIZADOS */}
          {tab === 'motos' && (
            <div className="space-y-2">
              {byRider.map((r, i) => (
                <div key={i} className="card p-4">
                  <div className="flex justify-between items-start">
                    <div>
                      <p className="font-bold text-gray-900 dark:text-white">{r.name}</p>
                      <p className="text-sm text-gray-500">{r.orders} pedidos · {r.balloons} balones</p>
                    </div>
                    <span className="font-bold text-orange-500">{fmt(r.revenue)}</span>
                  </div>
                </div>
              ))}
            </div>
          )}

          {/* CLIENTES TOP + INACTIVOS */}
          {tab === 'clientes' && (
            <div className="space-y-4">
              <div>
                <h3 className="font-bold text-gray-800 dark:text-gray-200 mb-2">🏆 Top 10 clientes</h3>
                <div className="space-y-2">
                  {topClients.map((c, i) => (
                    <div key={c.id} className="card p-3 flex items-center gap-3">
                      <span className="text-lg font-black text-gray-300 w-6">#{i+1}</span>
                      <div className="flex-1">
                        <p className="font-semibold text-gray-900 dark:text-white text-sm">{c.name}</p>
                        <p className="text-xs text-gray-400">{c.orders} pedidos · {c.balloons} balones</p>
                      </div>
                      <span className="font-bold text-orange-500">{fmt(c.revenue)}</span>
                    </div>
                  ))}
                </div>
              </div>

              <div>
                <div className="flex items-center justify-between mb-2">
                  <h3 className="font-bold text-gray-800 dark:text-gray-200">⚠ Clientes inactivos</h3>
                  <button onClick={exportInactive} className="flex items-center gap-1 text-sm text-blue-600 font-medium">
                    <Download size={14} /> Excel
                  </button>
                </div>
                <div className="flex gap-2 mb-3">
                  {[7, 14, 30].map(d => (
                    <button key={d} onClick={() => setInactiveDays(d)}
                      className={`flex-1 py-2 rounded-xl text-sm font-medium
                        ${inactiveDays === d ? 'bg-yellow-500 text-white' : 'bg-gray-100 dark:bg-gray-800 text-gray-500'}`}>
                      +{d}d
                    </button>
                  ))}
                </div>
                <div className="space-y-2">
                  {inactive.map(c => (
                    <div key={c.id} className="card p-3 flex items-center justify-between">
                      <div>
                        <p className="font-semibold text-sm text-gray-900 dark:text-white">{c.name}</p>
                        <p className="text-xs text-gray-400">{c.zone} · {c.phone}</p>
                      </div>
                      <div className="text-right">
                        <p className="text-xs text-yellow-600 font-semibold">
                          {c.last_order
                            ? `${Math.floor((Date.now()-new Date(c.last_order))/86400000)}d`
                            : 'Nunca'}
                        </p>
                        {c.phone && (
                          <a href={`https://wa.me/51${c.phone}`} target="_blank" rel="noopener noreferrer"
                            className="text-xs text-green-600 font-medium">WA</a>
                        )}
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            </div>
          )}

          {/* DEUDAS */}
          {tab === 'deudas' && (
            <div className="space-y-2">
              {debts.length === 0 ? (
                <div className="card p-6 text-center text-green-600 font-semibold">
                  ✅ No hay deudas pendientes
                </div>
              ) : (
                <>
                  <div className="card p-3 bg-red-50 dark:bg-red-900/20">
                    <p className="text-sm font-semibold text-red-600 dark:text-red-400">
                      Total en deudas: {fmt(debts.reduce((s,d)=>s+d.debt,0))} · {debts.length} clientes
                    </p>
                  </div>
                  {debts.map(c => (
                    <div key={c.id} className="card p-3 flex items-center justify-between">
                      <div>
                        <p className="font-semibold text-sm text-gray-900 dark:text-white">{c.name}</p>
                        <p className="text-xs text-gray-400">{c.zone} · {c.phone}</p>
                      </div>
                      <div className="text-right">
                        <p className="font-bold text-red-500 text-lg">{fmt(c.debt)}</p>
                        {c.phone && (
                          <a href={`https://wa.me/51${c.phone}`} target="_blank" rel="noopener noreferrer"
                            className="text-xs text-green-600">Cobrar por WA</a>
                        )}
                      </div>
                    </div>
                  ))}
                </>
              )}
            </div>
          )}
        </>
      )}
      <div className="h-4" />
    </div>
  );
}
