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
  const [dailyDate, setDailyDate] = useState(() => new Date().toISOString().slice(0,10));
  const [dailyData, setDailyData] = useState(null);
  const [dailyLoading, setDailyLoading] = useState(false);

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

  const loadDaily = async (date) => {
    setDailyLoading(true);
    try {
      const data = await reports.dailyDetail({ date });
      setDailyData(data);
    } catch { toast.error('Error cargando reporte diario'); }
    finally { setDailyLoading(false); }
  };

  useEffect(() => { if (tab === 'diario') loadDaily(dailyDate); }, [tab, dailyDate]);

  const totalRevenue  = sales.reduce((s, d) => s + d.revenue, 0);
  const totalBalloons = sales.reduce((s, d) => s + d.balloons_10 + d.balloons_40, 0);
  const totalOrders   = sales.reduce((s, d) => s + d.orders, 0);

  const exportInactive = () => {
    window.open(reports.exportInactive(inactiveDays), '_blank');
    toast.success('Descargando Excel...');
  };

  const TABS = [
    { id: 'diario',    label: 'Diario',    icon: TrendingUp },
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
          {/* DIARIO */}
          {tab === 'diario' && (
            <div className="space-y-3">
              <input
                type="date" className="input"
                value={dailyDate}
                onChange={e => setDailyDate(e.target.value)}
              />
              {dailyLoading ? (
                <div className="card h-40 animate-pulse bg-gray-100 dark:bg-gray-800" />
              ) : dailyData ? (
                <>
                  {/* Summary */}
                  <div className="grid grid-cols-2 gap-2">
                    <div className="card p-3 text-center">
                      <div className="text-2xl font-bold text-orange-500">{fmt(dailyData.summary.revenue)}</div>
                      <div className="text-xs text-gray-500">Ingresos</div>
                    </div>
                    <div className="card p-3 text-center">
                      <div className="text-2xl font-bold text-blue-700 dark:text-blue-400">
                        {dailyData.summary.balloons_10 + dailyData.summary.balloons_45}
                      </div>
                      <div className="text-xs text-gray-500">Balones entregados</div>
                    </div>
                    <div className="card p-3 text-center">
                      <div className="text-xl font-bold text-green-600">{dailyData.summary.delivered}</div>
                      <div className="text-xs text-gray-500">Entregados</div>
                    </div>
                    <div className="card p-3 text-center">
                      <div className="text-xl font-bold text-yellow-600">{dailyData.summary.pending + dailyData.summary.in_transit}</div>
                      <div className="text-xs text-gray-500">Pendientes</div>
                    </div>
                  </div>

                  {/* By payment */}
                  <div className="card p-4">
                    <h4 className="font-bold text-gray-800 dark:text-gray-200 text-sm mb-2">Por forma de pago</h4>
                    <div className="grid grid-cols-2 gap-2">
                      {Object.entries(dailyData.summary.by_payment).map(([pm, rev]) => (
                        <div key={pm} className="flex justify-between text-sm">
                          <span className="text-gray-500">{pm}</span>
                          <span className="font-semibold text-gray-800 dark:text-gray-200">{fmt(rev)}</span>
                        </div>
                      ))}
                    </div>
                  </div>

                  {/* By rider */}
                  {dailyData.summary.by_rider.length > 0 && (
                    <div className="card p-4">
                      <h4 className="font-bold text-gray-800 dark:text-gray-200 text-sm mb-2">Por motorizado</h4>
                      <div className="space-y-2">
                        {dailyData.summary.by_rider.map((r, i) => (
                          <div key={i} className="flex items-center justify-between text-sm">
                            <div>
                              <span className="font-semibold text-gray-800 dark:text-gray-200">{r.rider_name}</span>
                              <span className="text-gray-400 text-xs ml-2">{r.orders} pedidos · {r.balloons} balones</span>
                            </div>
                            <span className="font-bold text-orange-500">{fmt(r.revenue)}</span>
                          </div>
                        ))}
                      </div>
                    </div>
                  )}

                  {/* Balloon detail */}
                  <div className="card p-4">
                    <h4 className="font-bold text-gray-800 dark:text-gray-200 text-sm mb-2">Detalle balones</h4>
                    <div className="space-y-1">
                      <div className="flex justify-between text-sm">
                        <span className="text-gray-500">10 kg (total)</span>
                        <span className="font-semibold text-gray-800 dark:text-gray-200">{dailyData.summary.balloons_10}</span>
                      </div>
                      {(dailyData.summary.balloons_10_normal > 0 || dailyData.summary.balloons_10_premium > 0) && (
                        <>
                          <div className="flex justify-between text-xs pl-3">
                            <span className="text-gray-400">└ válvula normal</span>
                            <span className="text-gray-600 dark:text-gray-400">{dailyData.summary.balloons_10_normal}</span>
                          </div>
                          <div className="flex justify-between text-xs pl-3">
                            <span className="text-gray-400">└ válvula premium</span>
                            <span className="text-gray-600 dark:text-gray-400">{dailyData.summary.balloons_10_premium}</span>
                          </div>
                        </>
                      )}
                      <div className="flex justify-between text-sm mt-1">
                        <span className="text-gray-500">45 kg</span>
                        <span className="font-semibold text-gray-800 dark:text-gray-200">{dailyData.summary.balloons_45}</span>
                      </div>
                    </div>
                    {dailyData.summary.by_brand?.length > 0 && (
                      <div className="mt-3 pt-2 border-t border-gray-100 dark:border-gray-700">
                        <p className="text-xs text-gray-400 mb-1">Por marca</p>
                        <div className="space-y-1">
                          {dailyData.summary.by_brand.map(b => (
                            <div key={b.brand} className="flex justify-between text-xs">
                              <span className="text-gray-500">{b.brand}</span>
                              <span className="font-medium text-gray-700 dark:text-gray-300">{b.quantity}</span>
                            </div>
                          ))}
                        </div>
                      </div>
                    )}
                  </div>

                  {/* Otros productos */}
                  {(dailyData.summary.valvulas_normal_individuales?.quantity > 0 ||
                    dailyData.summary.valvulas_premium_individuales?.quantity > 0 ||
                    dailyData.summary.kits?.quantity > 0 ||
                    dailyData.summary.otros_productos?.quantity > 0) && (
                    <div className="card p-4">
                      <h4 className="font-bold text-gray-800 dark:text-gray-200 text-sm mb-2">Otros productos</h4>
                      <div className="space-y-1">
                        {dailyData.summary.valvulas_normal_individuales?.quantity > 0 && (
                          <div className="flex justify-between text-sm">
                            <span className="text-gray-500">Válvulas normal</span>
                            <span className="font-semibold text-gray-800 dark:text-gray-200">
                              {dailyData.summary.valvulas_normal_individuales.quantity} · {fmt(dailyData.summary.valvulas_normal_individuales.amount)}
                            </span>
                          </div>
                        )}
                        {dailyData.summary.valvulas_premium_individuales?.quantity > 0 && (
                          <div className="flex justify-between text-sm">
                            <span className="text-gray-500">Válvulas premium</span>
                            <span className="font-semibold text-gray-800 dark:text-gray-200">
                              {dailyData.summary.valvulas_premium_individuales.quantity} · {fmt(dailyData.summary.valvulas_premium_individuales.amount)}
                            </span>
                          </div>
                        )}
                        {dailyData.summary.kits?.quantity > 0 && (
                          <div className="flex justify-between text-sm">
                            <span className="text-gray-500">Kits completos</span>
                            <span className="font-semibold text-gray-800 dark:text-gray-200">
                              {dailyData.summary.kits.quantity} · {fmt(dailyData.summary.kits.amount)}
                            </span>
                          </div>
                        )}
                        {dailyData.summary.otros_productos?.quantity > 0 && (
                          <div className="flex justify-between text-sm">
                            <span className="text-gray-500">Accesorios / otros</span>
                            <span className="font-semibold text-gray-800 dark:text-gray-200">
                              {dailyData.summary.otros_productos.quantity} · {fmt(dailyData.summary.otros_productos.amount)}
                            </span>
                          </div>
                        )}
                      </div>
                    </div>
                  )}

                  {/* Orders list */}
                  <h4 className="font-bold text-gray-800 dark:text-gray-200 text-sm">Pedidos del día ({dailyData.orders.length})</h4>
                  {dailyData.orders.map(o => (
                    <div key={o.id} className="card p-3">
                      <div className="flex items-center justify-between">
                        <span className="font-semibold text-gray-900 dark:text-white text-sm">{o.client_name || '—'}</span>
                        <span className="font-bold text-orange-500">{fmt(o.total)}</span>
                      </div>
                      <div className="text-xs text-gray-400 mt-1">
                        {o.status} · {o.payment_method}
                        {o.payment_destination ? ` → ${o.payment_destination}` : ''}
                        {' · '}{o.rider_name || 'Sin asignar'}
                      </div>
                      {o.reconciliation_status && o.reconciliation_status !== 'sin_registrar' && (
                        <div className="text-xs mt-0.5">
                          <span className={`inline-block px-1.5 py-0.5 rounded text-[10px] font-medium
                            ${o.reconciliation_status === 'confirmado'
                              ? 'bg-green-100 text-green-700 dark:bg-green-900/30 dark:text-green-400'
                              : o.reconciliation_status === 'rechazado'
                              ? 'bg-red-100 text-red-700 dark:bg-red-900/30 dark:text-red-400'
                              : 'bg-yellow-100 text-yellow-700 dark:bg-yellow-900/30 dark:text-yellow-400'}`}>
                            {o.reconciliation_status}
                          </span>
                        </div>
                      )}
                      {o.items?.length > 0 && (
                        <div className="text-xs text-gray-500 mt-1">
                          {o.items.map(i => `${i.quantity}× ${i.product_name_snapshot || i.product}`).join(' · ')}
                        </div>
                      )}
                    </div>
                  ))}
                </>
              ) : null}
            </div>
          )}

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
