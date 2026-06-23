import axios from 'axios';

const api = axios.create({ baseURL: '/api', timeout: 10000 });

export const auth = {
  verify: (pin) => api.post('/auth/verify', { pin }).then(r => r.data),
};

export const dashboard = {
  get: () => api.get('/dashboard').then(r => r.data),
};

export const clients = {
  list:   (params) => api.get('/clients', { params }).then(r => r.data),
  get:    (id)     => api.get(`/clients/${id}`).then(r => r.data),
  create: (data)   => api.post('/clients', data).then(r => r.data),
  update: (id, data) => api.put(`/clients/${id}`, data).then(r => r.data),
  delete: (id)     => api.delete(`/clients/${id}`).then(r => r.data),
};

export const orders = {
  list:         (params) => api.get('/orders', { params }).then(r => r.data),
  get:          (id)     => api.get(`/orders/${id}`).then(r => r.data),
  create:       (data)   => api.post('/orders', data).then(r => r.data),
  update:       (id, data) => api.put(`/orders/${id}`, data).then(r => r.data),
  updateStatus: (id, status) => api.patch(`/orders/${id}/status`, { status }).then(r => r.data),
  delete:       (id)     => api.delete(`/orders/${id}`).then(r => r.data),
};

export const riders = {
  list:   ()       => api.get('/riders').then(r => r.data),
  get:    (id)     => api.get(`/riders/${id}`).then(r => r.data),
  create: (data)   => api.post('/riders', data).then(r => r.data),
  update: (id, data) => api.put(`/riders/${id}`, data).then(r => r.data),
};

export const reports = {
  sales:     (params) => api.get('/reports/sales', { params }).then(r => r.data),
  byZone:    (params) => api.get('/reports/by-zone', { params }).then(r => r.data),
  byProduct: (params) => api.get('/reports/by-product', { params }).then(r => r.data),
  byRider:   (params) => api.get('/reports/by-rider', { params }).then(r => r.data),
  topClients:(params) => api.get('/reports/top-clients', { params }).then(r => r.data),
  inactive:  (params) => api.get('/reports/inactive', { params }).then(r => r.data),
  debts:     ()       => api.get('/reports/debts').then(r => r.data),
  avgTicket: (params) => api.get('/reports/avg-ticket', { params }).then(r => r.data),
  exportInactive: (days) => `/api/reports/export/inactive?days=${days}`,
};

export const config = {
  get:    ()     => api.get('/config').then(r => r.data),
  update: (data) => api.put('/config', data).then(r => r.data),
};

export default api;
