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
  exportUrl: (params = {}) => {
    const qs = new URLSearchParams(
      Object.entries(params).filter(([, v]) => v != null && v !== '')
    ).toString();
    return `/api/clients/export${qs ? `?${qs}` : ''}`;
  },
};

export const orders = {
  list:         (params) => api.get('/orders', { params }).then(r => r.data),
  get:          (id)     => api.get(`/orders/${id}`).then(r => r.data),
  create:       (data)   => api.post('/orders', data).then(r => r.data),
  update:       (id, data) => api.put(`/orders/${id}`, data).then(r => r.data),
  // `geo` es opcional: { lat, lng, accuracy }, o null/omitido si no hubo GPS.
  updateStatus: (id, status, reason, geo) => api.patch(`/orders/${id}/status`, { status, reason, ...(geo || {}) }).then(r => r.data),
  delete:       (id)     => api.delete(`/orders/${id}`).then(r => r.data),
};

export const riders = {
  list:   ()       => api.get('/riders').then(r => r.data),
  get:    (id)     => api.get(`/riders/${id}`).then(r => r.data),
  inbox:  (id)     => api.get(`/riders/${id}/inbox`).then(r => r.data),
  create: (data)   => api.post('/riders', data).then(r => r.data),
  update: (id, data) => api.put(`/riders/${id}`, data).then(r => r.data),
};

export const payments = {
  getByOrder:     (orderId)           => api.get(`/orders/${orderId}/payments`).then(r => r.data),
  create:         (orderId, data)     => api.post(`/orders/${orderId}/payments`, data).then(r => r.data),
  confirm:        (paymentId, data)   => api.patch(`/payments/${paymentId}/confirm`, data).then(r => r.data),
  reject:         (paymentId, data)   => api.patch(`/payments/${paymentId}/reject`, data).then(r => r.data),
  handoverCash:   (handoverId, data)  => api.patch(`/cash-handovers/${handoverId}/handover`, data).then(r => r.data),
  confirmHandover:(handoverId, data)  => api.patch(`/cash-handovers/${handoverId}/confirm`, data).then(r => r.data),
  summary:        (params)            => api.get('/reports/payments-summary', { params }).then(r => r.data),
};

export const catalog = {
  list:           ()         => api.get('/catalog').then(r => r.data),
  available:      ()         => api.get('/catalog/available').then(r => r.data),
  createProduct:  (data)     => api.post('/catalog/products', data).then(r => r.data),
  updateProduct:  (id, data) => api.put(`/catalog/products/${id}`, data).then(r => r.data),
  createVariant:  (data)     => api.post('/catalog/variants', data).then(r => r.data),
  updateVariant:  (id, data) => api.put(`/catalog/variants/${id}`, data).then(r => r.data),
};

export const inventory = {
  stock:      ()       => api.get('/inventory/stock').then(r => r.data),
  adjust:     (data)   => api.post('/inventory/adjust', data).then(r => r.data),
  movements:  (params) => api.get('/inventory/movements', { params }).then(r => r.data),
};

export const reports = {
  sales:       (params) => api.get('/reports/sales', { params }).then(r => r.data),
  byZone:      (params) => api.get('/reports/by-zone', { params }).then(r => r.data),
  byProduct:   (params) => api.get('/reports/by-product', { params }).then(r => r.data),
  byRider:     (params) => api.get('/reports/by-rider', { params }).then(r => r.data),
  topClients:  (params) => api.get('/reports/top-clients', { params }).then(r => r.data),
  inactive:    (params) => api.get('/reports/inactive', { params }).then(r => r.data),
  debts:       ()       => api.get('/reports/debts').then(r => r.data),
  avgTicket:   (params) => api.get('/reports/avg-ticket', { params }).then(r => r.data),
  dailyDetail: (params) => api.get('/reports/daily-detail', { params }).then(r => r.data),
  exportInactive: (days) => `/api/reports/export/inactive?days=${days}`,
};

export const config = {
  get:    ()     => api.get('/config').then(r => r.data),
  update: (data) => api.put('/config', data).then(r => r.data),
};

export const conversations = {
  list:        (params)      => api.get('/conversations', { params }).then(r => r.data),
  unreadCount: ()            => api.get('/conversations/unread-count').then(r => r.data),
  getMessages:(id, params)   => api.get(`/conversations/${id}/messages`, { params }).then(r => r.data),
  send:       (id, data)     => api.post(`/conversations/${id}/messages`, data).then(r => r.data),
  markRead:   (id)           => api.patch(`/conversations/${id}/read`).then(r => r.data),
  setStatus:  (id, status)   => api.patch(`/conversations/${id}/status`, { status }).then(r => r.data),
  sendTemplate: (id, data)   => api.post(`/conversations/${id}/template`, data).then(r => r.data),
};

export default api;
