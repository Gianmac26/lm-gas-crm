import React, { useState, useRef, useEffect } from 'react';
import { auth } from '../api.js';
import toast from 'react-hot-toast';

export default function Login({ onSuccess }) {
  const [pin, setPin] = useState(['', '', '', '']);
  const [loading, setLoading] = useState(false);
  const [shake, setShake] = useState(false);
  const refs = [useRef(), useRef(), useRef(), useRef()];

  useEffect(() => { refs[0].current?.focus(); }, []);

  const handleKey = (i, e) => {
    const val = e.target.value.replace(/\D/g, '').slice(-1);
    const next = [...pin];
    next[i] = val;
    setPin(next);
    if (val && i < 3) refs[i + 1].current?.focus();
    if (next.every(d => d !== '') && val) {
      setTimeout(() => submit(next.join('')), 80);
    }
  };

  const handleKeyDown = (i, e) => {
    if (e.key === 'Backspace' && !pin[i] && i > 0) {
      refs[i - 1].current?.focus();
    }
  };

  const submit = async (code) => {
    setLoading(true);
    try {
      const res = await auth.verify(code);
      if (res.ok) { onSuccess(res); }
      else {
        toast.error('PIN incorrecto');
        setPin(['', '', '', '']);
        setShake(true);
        setTimeout(() => { setShake(false); refs[0].current?.focus(); }, 600);
      }
    } catch {
      toast.error('Error de conexión con el servidor');
    } finally { setLoading(false); }
  };

  return (
    <div className="min-h-screen bg-gradient-to-br from-blue-900 via-blue-800 to-blue-900 flex items-center justify-center p-6">
      <div className="w-full max-w-sm">
        {/* Logo */}
        <div className="text-center mb-10">
          <div className="text-6xl mb-4">🔥</div>
          <h1 className="text-3xl font-bold text-white">L&M Gas</h1>
          <p className="text-blue-300 mt-1 text-base">Distribuidora de Gas · Lima</p>
        </div>

        {/* PIN card */}
        <div className="card p-8">
          <h2 className="text-xl font-bold text-center text-gray-800 dark:text-gray-100 mb-2">
            Ingresa tu PIN
          </h2>
          <p className="text-center text-gray-500 text-sm mb-8">4 dígitos para acceder</p>

          <div className={`flex justify-center gap-4 mb-8 ${shake ? 'animate-bounce' : ''}`}>
            {pin.map((d, i) => (
              <input
                key={i}
                ref={refs[i]}
                type="tel"
                inputMode="numeric"
                maxLength={1}
                value={d}
                onChange={e => handleKey(i, e)}
                onKeyDown={e => handleKeyDown(i, e)}
                className={`w-16 h-16 text-center text-2xl font-bold border-2 rounded-2xl
                  bg-gray-50 dark:bg-gray-700 text-gray-900 dark:text-white
                  focus:outline-none focus:border-orange-500 transition-colors
                  ${d ? 'border-orange-400 bg-orange-50' : 'border-gray-300 dark:border-gray-600'}`}
                disabled={loading}
              />
            ))}
          </div>

          <button
            onClick={() => pin.every(d => d) && submit(pin.join(''))}
            disabled={loading || pin.some(d => !d)}
            className="btn-primary w-full text-lg py-4 disabled:opacity-50"
          >
            {loading ? 'Verificando...' : 'Entrar'}
          </button>

          <p className="text-center text-xs text-gray-400 mt-6">
            PIN por defecto: <strong>1234</strong>
          </p>
        </div>
      </div>
    </div>
  );
}
