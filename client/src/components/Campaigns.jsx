import React, { useState, useEffect, useMemo } from 'react';
import { Megaphone, CheckCircle, XCircle, Clock, ChevronRight, ArrowLeft } from 'lucide-react';
import api from '../api';

// Helper component for styled cards
const Card = ({ children, onClick, selected, disabled }) => (
  <div
    className={`p-4 border rounded-lg cursor-pointer transition-all ${
      selected ? 'border-orange-500 bg-orange-50 ring-2 ring-orange-500' : 'border-gray-300 bg-white hover:border-gray-400'
    } ${disabled ? 'opacity-50 cursor-not-allowed' : ''}`}
    onClick={!disabled ? onClick : undefined}
  >
    {children}
  </div>
);

const Badge = ({ children, color }) => {
  const colors = {
    orange: 'bg-orange-100 text-orange-800',
    blue: 'bg-blue-100 text-blue-800',
  };
  return <span className={`px-2 py-1 text-xs font-medium rounded-full ${colors[color]}`}>{children}</span>;
};


export default function Campaigns() {
  const [view, setView] = useState('wizard'); // 'wizard' or 'history'
  const [step, setStep] = useState(1);

  // API Data
  const [templates, setTemplates] = useState([]);
  const [eligibleClients, setEligibleClients] = useState([]);
  const [zones, setZones] = useState([]);
  const [history, setHistory] = useState([]);

  // Selections
  const [segment, setSegment] = useState(null);
  const [filters, setFilters] = useState({ zone: 'all', type: 'all' });
  const [selectedTemplate, setSelectedTemplate] = useState(null);
  const [variableMap, setVariableMap] = useState({});

  // UI State
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);
  const [campaignResult, setCampaignResult] = useState(null);

  // Fetch initial data. Cada llamada se resuelve por separado: si las plantillas
  // de WhatsApp fallan (ej. falta configurar WHATSAPP_ACCESS_TOKEN), igual se
  // cargan las zonas y el historial en vez de perder los tres por un solo fallo.
  useEffect(() => {
    async function fetchData() {
      setLoading(true);
      const [templatesResult, configResult, historyResult] = await Promise.allSettled([
        api.get('/campaigns/templates').then(r => r.data),
        api.get('/config').then(r => r.data),
        api.get('/campaigns/history').then(r => r.data)
      ]);

      if (templatesResult.status === 'fulfilled') {
        setTemplates(templatesResult.value);
      } else {
        setError('No se pudieron cargar las plantillas de WhatsApp. ' + templatesResult.reason.message);
      }

      if (configResult.status === 'fulfilled') {
        setZones(configResult.value.zones ? configResult.value.zones.split(',') : []);
      }

      if (historyResult.status === 'fulfilled') {
        setHistory(historyResult.value);
      }

      setLoading(false);
    }
    fetchData();
  }, []);

  // Fetch eligible clients when segment or filters change
  useEffect(() => {
    if (!segment) return;
    async function fetchClients() {
      setLoading(true);
      setError(null);
      try {
        const params = new URLSearchParams({ segment: segment.key, ...filters });
        const clients = await api.get(`/campaigns/eligible-clients?${params.toString()}`).then(r => r.data);
        setEligibleClients(clients);
      } catch (err) {
        setError('Error al cargar clientes elegibles. ' + err.message);
        setEligibleClients([]);
      }
      setLoading(false);
    }
    fetchClients();
  }, [segment, filters]);
  
  const resetWizard = () => {
    setStep(1);
    setSegment(null);
    setFilters({ zone: 'all', type: 'all' });
    setSelectedTemplate(null);
    setVariableMap({});
    setEligibleClients([]);
    setCampaignResult(null);
    setError(null);
  };

  const handleSendCampaign = async () => {
    setStep(5); // Go to results page
    setLoading(true);
    setError(null);
    setCampaignResult(null);

    const payload = {
      template_name: selectedTemplate.name,
      template_language: selectedTemplate.language,
      client_ids: eligibleClients.map(c => c.id),
      variable_mapping: variableMap
    };

    try {
      const result = await api.post('/campaigns/send', payload).then(r => r.data);
      setCampaignResult(result);
    } catch (err) {
      setError('Error al enviar la campaña. ' + err.message);
    }
    setLoading(false);
  };
  
  const SEGMENTS = [
    { key: 'inactive_7', label: 'Inactivos +7 días' },
    { key: 'inactive_14', label: 'Inactivos +14 días' },
    { key: 'inactive_30', label: 'Inactivos +30 días' },
    { key: 'inactive_60', label: 'Inactivos +60 días' },
    { key: 'all', label: 'Todos los clientes' },
  ];
  
  const CLIENT_DATA_FIELDS = [
    { key: 'nombre', label: 'Nombre del Cliente' },
    { key: 'dias_sin_pedir', label: 'Días sin pedir' },
    { key: 'zona', label: 'Zona' },
    { key: 'tipo', label: 'Tipo' },
  ];
  
  const filteredTemplates = useMemo(() => {
    if (!segment) return templates;
    // Only allow marketing templates for reactivation segments
    if (segment.key.startsWith('inactive')) {
      return templates.filter(t => t.category === 'MARKETING');
    }
    return templates;
  }, [templates, segment]);
  
  const getPreview = (template, client, mapping) => {
    const text = template?.components?.find(c => c.type === 'BODY')?.text || '';
    if (!text || !template.components) return 'No hay preview disponible.';

    const variables = template.components.find(c => c.type === 'BODY')?.example?.body_text?.[0] || [];

    // Construye un array de nodos de React (texto plano + <strong> como wrapper),
    // en vez de una cadena HTML, para que React escape el dato del cliente por defecto.
    let parts = [text];
    variables.forEach((varValue, index) => {
      const key = String(index + 1);
      const placeholder = `{{${key}}}`;
      const mappedValue = mapping[key];
      let replacement = placeholder;

      if (mappedValue && client && client[mappedValue]) {
        replacement = client[mappedValue];
      } else if (mappedValue) {
        replacement = mappedValue;
      }

      parts = parts.flatMap(part => {
        if (typeof part !== 'string') return [part];
        const idx = part.indexOf(placeholder);
        if (idx === -1) return [part];
        return [
          part.slice(0, idx),
          <strong key={`var-${key}`}>{replacement}</strong>,
          part.slice(idx + placeholder.length),
        ];
      });
    });
    return parts;
  };
  
  const renderHeader = () => (
    <div className="flex items-center justify-between mb-6">
      <h1 className="text-2xl font-bold text-gray-800 flex items-center">
        <Megaphone className="mr-3 text-orange-500" />
        Campañas Masivas de WhatsApp
      </h1>
      <div>
        <button
          onClick={() => setView('wizard')}
          className={`px-4 py-2 rounded-l-lg ${view === 'wizard' ? 'bg-orange-500 text-white' : 'bg-gray-200 text-gray-700'}`}
        >
          Nueva Campaña
        </button>
        <button
          onClick={() => setView('history')}
          className={`px-4 py-2 rounded-r-lg ${view === 'history' ? 'bg-orange-500 text-white' : 'bg-gray-200 text-gray-700'}`}
        >
          Historial
        </button>
      </div>
    </div>
  );

  const renderWizard = () => (
    <>
      {/* Step Indicator */}
      <div className="mb-8 flex items-center justify-center">
        {[1, 2, 3, 4, 5].map(s => (
          <React.Fragment key={s}>
            <div className={`flex items-center justify-center w-8 h-8 rounded-full ${step >= s ? 'bg-orange-500 text-white' : 'bg-gray-200 text-gray-500'}`}>
              {step > s ? <CheckCircle size={18} /> : s}
            </div>
            {s < 5 && <div className={`flex-auto border-t-2 ${step > s ? 'border-orange-500' : 'border-gray-200'}`}></div>}
          </React.Fragment>
        ))}
      </div>

      {step > 1 && step < 5 && (
        <button onClick={() => setStep(s => s - 1)} className="mb-4 flex items-center text-sm text-gray-600 hover:text-gray-900">
          <ArrowLeft size={16} className="mr-1" /> Volver al paso anterior
        </button>
      )}

      {step === 1 && renderStep1()}
      {step === 2 && renderStep2()}
      {step === 3 && renderStep3()}
      {step === 4 && renderStep4()}
      {step === 5 && renderStep5()}
    </>
  );

  const renderStep1 = () => (
    <div>
      <h2 className="text-xl font-semibold mb-2">Paso 1: ¿A quién quieres enviar?</h2>
      <p className="text-gray-600 mb-4">Selecciona un segmento de clientes para tu campaña.</p>
      
      <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-5 gap-4 mb-6">
        {SEGMENTS.map(s => (
          <Card key={s.key} onClick={() => setSegment(s)} selected={segment?.key === s.key}>
            <h3 className="font-bold text-lg">{s.label}</h3>
          </Card>
        ))}
      </div>

      {segment && (
        <>
          <h3 className="text-lg font-semibold mb-4">Filtros Opcionales</h3>
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4 mb-4">
            <div>
              <label htmlFor="zone-filter" className="block text-sm font-medium text-gray-700 mb-1">Zona</label>
              <select id="zone-filter" value={filters.zone} onChange={e => setFilters(f => ({...f, zone: e.target.value}))} className="w-full p-2 border rounded-md">
                <option value="all">Todas</option>
                {zones.map(z => <option key={z} value={z}>{z}</option>)}
              </select>
            </div>
            <div>
              <label htmlFor="type-filter" className="block text-sm font-medium text-gray-700 mb-1">Tipo de Cliente</label>
              <select id="type-filter" value={filters.type} onChange={e => setFilters(f => ({...f, type: e.target.value}))} className="w-full p-2 border rounded-md">
                <option value="all">Todos</option>
                <option value="Residencial">Residencial</option>
                <option value="Negocio">Negocio</option>
              </select>
            </div>
          </div>
          
          <div className="mt-6 bg-gray-50 p-4 rounded-lg">
            {loading && <p>Cargando clientes...</p>}
            {error && <p className="text-red-500">{error}</p>}
            {!loading && !error && (
              <>
                <h3 className="font-bold text-lg text-gray-800">{eligibleClients.length} Clientes Elegibles</h3>
                {eligibleClients.length > 0 && (
                  <>
                  <ul className="text-sm text-gray-600 mt-2 max-h-40 overflow-y-auto">
                    {eligibleClients.slice(0,10).map(c => <li key={c.id}>{c.nombre}</li>)}
                    {eligibleClients.length > 10 && <li>... y {eligibleClients.length - 10} más.</li>}
                  </ul>
                  <button onClick={() => setStep(2)} className="mt-4 bg-orange-500 text-white font-bold py-2 px-4 rounded-lg flex items-center">
                    Siguiente <ChevronRight size={20} className="ml-1" />
                  </button>
                  </>
                )}
              </>
            )}
          </div>
        </>
      )}
    </div>
  );

  const renderStep2 = () => (
    <div>
      <h2 className="text-xl font-semibold mb-2">Paso 2: Elige una plantilla</h2>
      <p className="text-gray-600 mb-4">Estas son las plantillas aprobadas por Meta para tu cuenta.</p>
      
      {loading && <p>Cargando plantillas...</p>}
      {error && <p className="text-red-500">{error}</p>}

      <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
        {filteredTemplates.map(t => (
          <Card key={t.name} onClick={() => setSelectedTemplate(t)} selected={selectedTemplate?.name === t.name}>
            <div className="flex justify-between items-center mb-2">
              <h3 className="font-bold text-lg">{t.name}</h3>
              <Badge color={t.category === 'MARKETING' ? 'orange' : 'blue'}>{t.category}</Badge>
            </div>
            <p className="text-sm text-gray-600 bg-gray-50 p-3 rounded-md">
              {getPreview(t, {}, {})}
            </p>
          </Card>
        ))}
      </div>
      
      {selectedTemplate && (
        <div className="mt-6 text-right">
          <button onClick={() => {
              const hasVars = selectedTemplate.components?.some(c => c.type === 'BODY' && c.text.includes('{{'));
              setStep(hasVars ? 3 : 4);
            }}
            className="bg-orange-500 text-white font-bold py-2 px-4 rounded-lg flex items-center ml-auto"
          >
            Siguiente <ChevronRight size={20} className="ml-1" />
          </button>
        </div>
      )}
    </div>
  );
  
  const renderStep3 = () => {
    const variables = selectedTemplate.components?.find(c => c.type === 'BODY')?.text.match(/\{\{[0-9]+\}\}/g)?.map(v => v.replace(/\{|\}/g, '')) || [];
    
    return (
      <div>
        <h2 className="text-xl font-semibold mb-2">Paso 3: Configura las variables</h2>
        <p className="text-gray-600 mb-4">Asigna un valor a cada variable de tu plantilla.</p>
        
        <div className="grid grid-cols-1 md:grid-cols-2 gap-8">
          <div>
            {variables.map(variable => (
              <div key={variable} className="mb-4">
                <label className="block text-lg font-medium text-gray-700 mb-2">Variable <code>{"{{"+variable+"}}"}</code></label>
                <select
                  className="w-full p-2 border rounded-md mb-2"
                  onChange={(e) => {
                    const value = e.target.value;
                    if (value === 'fixed') {
                      setVariableMap(vm => ({ ...vm, [variable]: '' }));
                    } else {
                      setVariableMap(vm => ({ ...vm, [variable]: value }));
                    }
                  }}
                >
                  <option value="">Seleccionar dato...</option>
                  <optgroup label="Dato del cliente">
                    {CLIENT_DATA_FIELDS.map(df => <option key={df.key} value={df.key}>{df.label}</option>)}
                  </optgroup>
                  <option value="fixed">Texto fijo</option>
                </select>

                {variableMap[variable] === '' && (
                  <input
                    type="text"
                    className="w-full p-2 border rounded-md"
                    placeholder="Escribe un valor fijo"
                    onChange={(e) => setVariableMap(vm => ({ ...vm, [variable]: e.target.value }))}
                  />
                )}
              </div>
            ))}
          </div>

          <div className="bg-gray-50 p-4 rounded-lg">
            <h3 className="font-bold mb-2">Preview en tiempo real</h3>
            <p className="text-sm text-gray-800">
              {getPreview(selectedTemplate, eligibleClients[0], variableMap)}
            </p>
          </div>
        </div>

        <div className="mt-6 text-right">
          <button onClick={() => setStep(4)} className="bg-orange-500 text-white font-bold py-2 px-4 rounded-lg flex items-center">
            Siguiente <ChevronRight size={20} className="ml-1" />
          </button>
        </div>
      </div>
    );
  };
  
  const renderStep4 = () => (
    <div>
      <h2 className="text-xl font-semibold mb-2">Paso 4: Confirmación</h2>
      <p className="text-gray-600 mb-4">Revisa los detalles de tu campaña antes de enviar.</p>
      
      <div className="space-y-4 bg-white p-6 rounded-lg border">
        <p><strong>Clientes:</strong> {eligibleClients.length} destinatarios del segmento "{segment.label}"</p>
        <p><strong>Plantilla:</strong> {selectedTemplate.name}</p>
        <div>
          <h3 className="font-bold mb-2">Mensaje final (preview con el primer cliente):</h3>
          <div className="bg-gray-100 p-4 rounded-md text-gray-800">
            {getPreview(selectedTemplate, eligibleClients[0], variableMap)}
          </div>
        </div>
      </div>
      
      <div className="mt-6 p-4 bg-yellow-50 border-l-4 border-yellow-400 text-yellow-700">
        <p className="font-bold">Advertencia</p>
        <p>Se enviarán {eligibleClients.length} mensajes. Esta acción no se puede deshacer.</p>
      </div>
      
      <div className="mt-6 text-right">
        <button onClick={handleSendCampaign} className="bg-orange-600 hover:bg-orange-700 text-white font-bold py-3 px-6 rounded-lg text-lg">
          Enviar Campaña
        </button>
      </div>
    </div>
  );

  const renderStep5 = () => (
    <div>
      <h2 className="text-xl font-semibold mb-2">Paso 5: Resultados</h2>
      {loading && (
        <div className="text-center">
          <div className="w-16 h-16 border-4 border-orange-500 border-t-transparent rounded-full animate-spin mx-auto mb-4"></div>
          <p className="text-gray-600">Enviando campaña... Esto puede tardar varios minutos.</p>
        </div>
      )}
      {error && <p className="text-red-500 bg-red-50 p-4 rounded-lg">{error}</p>}
      
      {campaignResult && (
        <div className="space-y-4">
          <div className="grid grid-cols-2 gap-4 text-center">
            <div className="bg-green-50 p-4 rounded-lg">
              <h3 className="text-3xl font-bold text-green-600 flex items-center justify-center"><CheckCircle className="mr-2"/> {campaignResult.sent}</h3>
              <p className="text-green-800">Enviados con éxito</p>
            </div>
            <div className="bg-red-50 p-4 rounded-lg">
              <h3 className="text-3xl font-bold text-red-600 flex items-center justify-center"><XCircle className="mr-2"/> {campaignResult.failed}</h3>
              <p className="text-red-800">Fallidos</p>
            </div>
          </div>
          
          {campaignResult.failed > 0 && (
            <div>
              <h4 className="font-bold mb-2">Detalle de errores:</h4>
              <ul className="text-sm text-red-700 max-h-48 overflow-y-auto bg-white p-3 rounded-md border">
                {campaignResult.results.filter(r => r.status === 'failed').map(r => (
                  <li key={r.client_id} className="py-1 border-b">
                    <strong>{r.nombre}:</strong> {r.error}
                  </li>
                ))}
              </ul>
            </div>
          )}

          <div className="mt-8 flex justify-center space-x-4">
            <button onClick={resetWizard} className="bg-orange-500 text-white font-bold py-2 px-4 rounded-lg">
              Nueva Campaña
            </button>
            <button onClick={() => { resetWizard(); setView('history'); }} className="bg-gray-600 text-white font-bold py-2 px-4 rounded-lg">
              Ver Historial
            </button>
          </div>
        </div>
      )}
    </div>
  );
  
  const renderHistory = () => (
    <div className="bg-white p-4 rounded-lg shadow-sm">
      <h2 className="text-xl font-semibold mb-4">Historial de Campañas</h2>
      {loading && <p>Cargando historial...</p>}
      {error && <p className="text-red-500">{error}</p>}
      <div className="overflow-x-auto">
        <table className="min-w-full divide-y divide-gray-200">
          <thead className="bg-gray-50">
            <tr>
              <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">Fecha</th>
              <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">Plantilla</th>
              <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">Enviados</th>
              <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">Fallidos</th>
              <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">Tasa de Éxito</th>
            </tr>
          </thead>
          <tbody className="bg-white divide-y divide-gray-200">
            {history.map(h => (
              <tr key={h.campaign_id}>
                <td className="px-6 py-4 whitespace-nowrap text-sm text-gray-500">{new Date(h.sent_at).toLocaleString()}</td>
                <td className="px-6 py-4 whitespace-nowrap text-sm font-medium text-gray-900">{h.template_name}</td>
                <td className="px-6 py-4 whitespace-nowrap text-sm text-green-600">{h.sent}</td>
                <td className="px-6 py-4 whitespace-nowrap text-sm text-red-600">{h.failed}</td>
                <td className="px-6 py-4 whitespace-nowrap text-sm text-gray-500">
                  {h.total > 0 ? `${((h.sent / h.total) * 100).toFixed(1)}%` : 'N/A'}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );

  return (
    <div className="p-6 bg-gray-100 min-h-screen">
      {renderHeader()}
      {view === 'wizard' ? renderWizard() : renderHistory()}
    </div>
  );
}
