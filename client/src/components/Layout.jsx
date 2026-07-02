import React, { useState, useEffect } from 'react';
import { Outlet, NavLink, useLocation } from 'react-router-dom';
import { LayoutDashboard, Users, ShoppingBag, BarChart2, Settings, Truck, MessageSquare, Package } from 'lucide-react';
import { conversations } from '../api.js';

const NAV = [
  { to: '/dashboard',     icon: LayoutDashboard, label: 'Inicio' },
  { to: '/clients',       icon: Users,           label: 'Clientes' },
  { to: '/orders',        icon: ShoppingBag,     label: 'Pedidos' },
  { to: '/riders',        icon: Truck,           label: 'Moto' },
  { to: '/conversations', icon: MessageSquare,   label: 'Bandeja' },
  { to: '/catalog',       icon: Package,         label: 'Catálogo' },
  { to: '/reports',       icon: BarChart2,       label: 'Reportes' },
  { to: '/config',        icon: Settings,        label: 'Config' },
];

export default function Layout() {
  const loc = useLocation();
  const [unread, setUnread] = useState(0);

  const refreshUnread = () =>
    conversations.unreadCount().then(d => setUnread(d.count || 0)).catch(() => {});

  // Al cargar y al cambiar de pantalla (p. ej. tras leer mensajes)
  useEffect(() => { refreshUnread(); }, [loc.pathname]);
  // Sondeo suave cada 30 s para avisar de mensajes nuevos estando en cualquier sección
  useEffect(() => { const t = setInterval(refreshUnread, 30000); return () => clearInterval(t); }, []);

  const title = () => {
    if (loc.pathname.startsWith('/dashboard')) return '🔥 L&M Gas';
    if (loc.pathname.startsWith('/clients'))   return 'Clientes';
    if (loc.pathname.startsWith('/orders'))    return 'Pedidos';
    if (loc.pathname.startsWith('/riders'))    return 'Motorizados';
    if (loc.pathname.startsWith('/reports'))   return 'Reportes';
    if (loc.pathname.startsWith('/config'))         return 'Configuración';
    if (loc.pathname.startsWith('/conversations')) return 'Bandeja';
    if (loc.pathname.startsWith('/catalog'))       return 'Catálogo';
    return 'L&M Gas';
  };

  return (
    <div className="flex flex-col min-h-screen bg-gray-50 dark:bg-gray-900">
      {/* Top bar */}
      <header className="sticky top-0 z-40 bg-blue-900 dark:bg-blue-950 text-white shadow-lg">
        <div className="max-w-2xl mx-auto px-4 h-14 flex items-center">
          <h1 className="text-lg font-bold tracking-tight">{title()}</h1>
        </div>
      </header>

      {/* Page content */}
      <main className="flex-1 max-w-2xl mx-auto w-full pb-24">
        <Outlet />
      </main>

      {/* Bottom navigation — scrollable so 8 items never overlap on any screen */}
      <nav className="fixed bottom-0 left-0 right-0 z-40 bg-white dark:bg-gray-800 border-t border-gray-200 dark:border-gray-700 pb-safe">
        <div className="max-w-2xl mx-auto h-16 flex overflow-x-auto scrollbar-none">
          {NAV.map(({ to, icon: Icon, label }) => (
            <NavLink
              key={to}
              to={to}
              className={({ isActive }) =>
                `flex-shrink-0 flex-1 min-w-[56px] flex flex-col items-center justify-center gap-0.5 text-[10px] font-medium transition-colors touch-manipulation select-none
                ${isActive
                  ? 'text-orange-500 dark:text-orange-400'
                  : 'text-gray-500 dark:text-gray-400 hover:text-gray-700 dark:hover:text-gray-200'}`
              }
            >
              <span className="relative">
                <Icon size={20} strokeWidth={1.8} />
                {to === '/conversations' && unread > 0 && (
                  <span className="absolute -top-1.5 -right-2 min-w-[16px] h-4 px-1 rounded-full bg-red-500 text-white text-[9px] font-bold flex items-center justify-center leading-none">
                    {unread > 99 ? '99+' : unread}
                  </span>
                )}
              </span>
              <span className="leading-none">{label}</span>
            </NavLink>
          ))}
        </div>
      </nav>
    </div>
  );
}
