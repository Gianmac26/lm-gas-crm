import React from 'react';
import { Outlet, NavLink, useLocation } from 'react-router-dom';
import { LayoutDashboard, Users, ShoppingBag, BarChart2, Settings, Truck } from 'lucide-react';

const NAV = [
  { to: '/dashboard', icon: LayoutDashboard, label: 'Inicio' },
  { to: '/clients',   icon: Users,           label: 'Clientes' },
  { to: '/orders',    icon: ShoppingBag,     label: 'Pedidos' },
  { to: '/riders',    icon: Truck,           label: 'Moto' },
  { to: '/reports',   icon: BarChart2,       label: 'Reportes' },
  { to: '/config',    icon: Settings,        label: 'Config' },
];

export default function Layout() {
  const loc = useLocation();

  const title = () => {
    if (loc.pathname.startsWith('/dashboard')) return '🔥 L&M Gas';
    if (loc.pathname.startsWith('/clients'))   return 'Clientes';
    if (loc.pathname.startsWith('/orders'))    return 'Pedidos';
    if (loc.pathname.startsWith('/riders'))    return 'Motorizados';
    if (loc.pathname.startsWith('/reports'))   return 'Reportes';
    if (loc.pathname.startsWith('/config'))    return 'Configuración';
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

      {/* Bottom navigation */}
      <nav className="fixed bottom-0 left-0 right-0 z-40 bg-white dark:bg-gray-800 border-t border-gray-200 dark:border-gray-700 pb-safe">
        <div className="max-w-2xl mx-auto grid grid-cols-6 h-16">
          {NAV.map(({ to, icon: Icon, label }) => (
            <NavLink
              key={to}
              to={to}
              className={({ isActive }) =>
                `flex flex-col items-center justify-center gap-0.5 text-[10px] font-medium transition-colors touch-manipulation
                ${isActive
                  ? 'text-orange-500 dark:text-orange-400'
                  : 'text-gray-500 dark:text-gray-400 hover:text-gray-700 dark:hover:text-gray-200'}`
              }
            >
              <Icon size={22} strokeWidth={1.8} />
              {label}
            </NavLink>
          ))}
        </div>
      </nav>
    </div>
  );
}
