import React, { useState, useEffect, createContext, useContext } from 'react';
import { Routes, Route, Navigate } from 'react-router-dom';
import { config } from './api.js';
import Login from './components/Login.jsx';
import Layout from './components/Layout.jsx';
import Dashboard from './components/Dashboard.jsx';
import Clients from './components/Clients.jsx';
import ClientDetail from './components/ClientDetail.jsx';
import ClientForm from './components/ClientForm.jsx';
import Orders from './components/Orders.jsx';
import OrderForm from './components/OrderForm.jsx';
import Riders from './components/Riders.jsx';
import Reports from './components/Reports.jsx';
import Config from './components/Config.jsx';
import Conversations from './components/Conversations.jsx';
import ConversationDetail from './components/ConversationDetail.jsx';
import Catalog from './components/Catalog.jsx';
import Campaigns from './components/Campaigns.jsx';
import RiderInbox from './components/RiderInbox.jsx';

export const AppContext = createContext(null);

export function useApp() { return useContext(AppContext); }

export default function App() {
  const [authed, setAuthed] = useState(() => sessionStorage.getItem('lm_auth') === '1');
  const [role, setRole] = useState(() => sessionStorage.getItem('lm_role') || 'admin');
  const [rider, setRider] = useState(() => {
    try { return JSON.parse(sessionStorage.getItem('lm_rider') || 'null'); } catch { return null; }
  });
  const [cfg, setCfg] = useState({});
  const [darkMode, setDarkMode] = useState(false);

  const handleLogin = (res) => {
    sessionStorage.setItem('lm_auth', '1');
    if (res?.role === 'rider') {
      const r = { id: res.rider_id, name: res.rider_name };
      sessionStorage.setItem('lm_role', 'rider');
      sessionStorage.setItem('lm_rider', JSON.stringify(r));
      setRole('rider'); setRider(r);
    } else {
      sessionStorage.setItem('lm_role', 'admin');
      sessionStorage.removeItem('lm_rider');
      setRole('admin'); setRider(null);
    }
    setAuthed(true);
  };

  const logout = () => {
    sessionStorage.removeItem('lm_auth');
    sessionStorage.removeItem('lm_role');
    sessionStorage.removeItem('lm_rider');
    setAuthed(false); setRole('admin'); setRider(null);
  };

  useEffect(() => {
    config.get().then(c => {
      setCfg(c);
      const dm = c.dark_mode === 'true';
      setDarkMode(dm);
      document.documentElement.classList.toggle('dark', dm);
    }).catch(() => {});
  }, []);

  const refreshConfig = () =>
    config.get().then(c => { setCfg(c); return c; });

  const toggleDark = () => {
    const next = !darkMode;
    setDarkMode(next);
    document.documentElement.classList.toggle('dark', next);
    config.update({ dark_mode: String(next) });
  };

  if (!authed) return <Login onSuccess={handleLogin} />;

  if (role === 'rider') return <RiderInbox rider={rider} onLogout={logout} />;

  return (
    <AppContext.Provider value={{ cfg, refreshConfig, toggleDark, darkMode }}>
      <Routes>
        <Route element={<Layout />}>
          <Route index element={<Navigate to="/dashboard" replace />} />
          <Route path="dashboard" element={<Dashboard />} />
          <Route path="clients" element={<Clients />} />
          <Route path="clients/new" element={<ClientForm />} />
          <Route path="clients/:id" element={<ClientDetail />} />
          <Route path="clients/:id/edit" element={<ClientForm />} />
          <Route path="orders" element={<Orders />} />
          <Route path="orders/new" element={<OrderForm />} />
          <Route path="orders/:id/edit" element={<OrderForm />} />
          <Route path="riders" element={<Riders />} />
          <Route path="reports" element={<Reports />} />
          <Route path="config" element={<Config />} />
          <Route path="conversations" element={<Conversations />} />
          <Route path="conversations/:id" element={<ConversationDetail />} />
          <Route path="catalog" element={<Catalog />} />
          <Route path="campaigns" element={<Campaigns />} />
        </Route>
      </Routes>
    </AppContext.Provider>
  );
}
