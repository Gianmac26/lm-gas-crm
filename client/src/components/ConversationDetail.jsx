import React, { useState, useEffect, useRef, useCallback } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { conversations as conversationsApi } from '../api.js';
import { ChevronLeft, Send, Check, CheckCheck, Clock, AlertCircle, User, Lock, Unlock } from 'lucide-react';

const POLL_INTERVAL = 5000;

function fmtTime(s) {
  if (!s) return '';
  return new Date(s).toLocaleTimeString('es-PE', { hour: '2-digit', minute: '2-digit' });
}

function fmtDate(s) {
  if (!s) return '';
  const d = new Date(s);
  const today = new Date();
  const diffDays = Math.floor((today - d) / 86400000);
  if (diffDays === 0) return 'Hoy';
  if (diffDays === 1) return 'Ayer';
  return d.toLocaleDateString('es-PE', { day: '2-digit', month: 'short', year: 'numeric' });
}

function MessageStatus({ status }) {
  if (status === 'queued')    return <Clock size={11} className="text-orange-200" />;
  if (status === 'sent')      return <Check size={11} className="text-orange-200" />;
  if (status === 'delivered') return <CheckCheck size={11} className="text-orange-200" />;
  if (status === 'read')      return <CheckCheck size={11} className="text-white" />;
  if (status === 'failed')    return <AlertCircle size={11} className="text-red-300" />;
  return null;
}

const ERROR_TEXT = {
  TEMPLATE_REQUIRED:
    'La ventana de atención de 24 horas terminó. Para volver a contactar al cliente se necesita una plantilla aprobada.',
  BODY_TOO_LONG:
    'El mensaje supera el límite de 4096 caracteres.',
  INVALID_PHONE:
    'El teléfono de esta conversación no es válido para WhatsApp.',
  CLIENT_REQUEST_ID_CONFLICT:
    'Ya existe un mensaje con ese identificador único.',
};

function getErrorText(code, fallback) {
  return ERROR_TEXT[code] || fallback || 'Error al enviar el mensaje. Intenta de nuevo.';
}

const MEDIA_LABELS = {
  image: '📷 Foto',
  video: '🎬 Video',
  audio: '🎤 Nota de voz',
  document: '📄 Documento',
  sticker: '😀 Sticker',
  location: '📍 Ubicación',
  contacts: '👤 Contacto',
};

function mediaLabel(type) {
  return MEDIA_LABELS[type] || '📎 Adjunto';
}

export default function ConversationDetail() {
  const { id } = useParams();
  const nav = useNavigate();
  const convId = Number(id);

  const [conversation, setConversation] = useState(null);
  const [messages, setMessages] = useState([]);
  const [loading, setLoading] = useState(true);
  const [fetchError, setFetchError] = useState(null);
  const [text, setText] = useState('');
  const [sending, setSending] = useState(false);
  const [sendError, setSendError] = useState(null);
  const [statusUpdating, setStatusUpdating] = useState(false);

  const messagesEndRef  = useRef(null);
  const chatRef         = useRef(null);
  const pollRef         = useRef(null);
  const fetchingRef     = useRef(false);
  const isNearBottomRef = useRef(true);
  const textareaRef     = useRef(null);

  const scrollToBottom = (instant = false) => {
    messagesEndRef.current?.scrollIntoView({ behavior: instant ? 'instant' : 'smooth' });
  };

  const handleChatScroll = () => {
    const el = chatRef.current;
    if (!el) return;
    isNearBottomRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < 100;
  };

  const loadMessages = useCallback(async (initial = false) => {
    if (fetchingRef.current) return;
    fetchingRef.current = true;
    try {
      const data = await conversationsApi.getMessages(convId);
      setConversation(data.conversation);
      setMessages(prev => {
        const incoming = data.messages || [];
        if (initial) {
          return incoming;
        }
        // Only update if something changed
        if (incoming.length === prev.length &&
            incoming[incoming.length - 1]?.id === prev[prev.length - 1]?.id &&
            incoming[incoming.length - 1]?.status === prev[prev.length - 1]?.status) {
          return prev;
        }
        return incoming;
      });
      setFetchError(null);
    } catch {
      if (initial) setFetchError('Error al cargar mensajes.');
    } finally {
      fetchingRef.current = false;
      if (initial) setLoading(false);
    }
  }, [convId]);

  // Scroll to bottom when messages update (only if near bottom or initial)
  const isInitialLoadRef = useRef(true);
  useEffect(() => {
    if (messages.length === 0) return;
    if (isInitialLoadRef.current) {
      isInitialLoadRef.current = false;
      scrollToBottom(true);
      return;
    }
    if (isNearBottomRef.current) scrollToBottom(false);
  }, [messages]);

  const markRead = useCallback(async () => {
    try { await conversationsApi.markRead(convId); } catch { /* non-critical */ }
  }, [convId]);

  useEffect(() => {
    loadMessages(true).then(() => markRead());

    const startPoll = () => {
      pollRef.current = setInterval(() => {
        if (document.visibilityState !== 'hidden') loadMessages(false);
      }, POLL_INTERVAL);
    };

    const handleVisibility = () => {
      if (document.visibilityState === 'hidden') {
        clearInterval(pollRef.current);
        pollRef.current = null;
      } else {
        loadMessages(false);
        startPoll();
      }
    };

    startPoll();
    document.addEventListener('visibilitychange', handleVisibility);
    return () => {
      clearInterval(pollRef.current);
      document.removeEventListener('visibilitychange', handleVisibility);
    };
  }, [loadMessages, markRead]);

  const autoResizeTextarea = () => {
    const el = textareaRef.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = Math.min(el.scrollHeight, 120) + 'px';
  };

  const handleSend = async () => {
    const trimmed = text.trim();
    if (!trimmed || sending) return;

    const clientRequestId = crypto.randomUUID();
    setSending(true);
    setSendError(null);

    try {
      const data = await conversationsApi.send(convId, {
        body: trimmed,
        client_request_id: clientRequestId,
      });
      setText('');
      if (textareaRef.current) {
        textareaRef.current.style.height = 'auto';
      }
      setMessages(prev => {
        const exists = prev.some(m => m.id === data.message.id);
        return exists
          ? prev.map(m => m.id === data.message.id ? data.message : m)
          : [...prev, data.message];
      });
      isNearBottomRef.current = true;
    } catch (err) {
      const errData = err?.response?.data;
      const code    = errData?.error;
      const msg     = errData?.message;
      setSendError(getErrorText(code, msg));
      if (errData?.whatsapp_message) {
        setMessages(prev => {
          const exists = prev.some(m => m.id === errData.whatsapp_message.id);
          return exists ? prev : [...prev, errData.whatsapp_message];
        });
      }
    } finally {
      setSending(false);
    }
  };

  const handleKeyDown = e => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      handleSend();
    }
  };

  const toggleStatus = async () => {
    if (!conversation || statusUpdating) return;
    const nextStatus = conversation.status === 'closed' ? 'open' : 'closed';
    setStatusUpdating(true);
    try {
      const updated = await conversationsApi.setStatus(convId, nextStatus);
      setConversation(updated);
    } catch { /* no crítico, el estado local no cambia */ }
    setStatusUpdating(false);
  };

  if (loading) {
    return (
      <div className="flex items-center justify-center h-64">
        <div className="animate-spin text-4xl">🔥</div>
      </div>
    );
  }

  if (fetchError && !conversation) {
    return (
      <div className="p-6 text-center">
        <p className="text-gray-500 dark:text-gray-400">{fetchError}</p>
        <button onClick={() => { setLoading(true); setFetchError(null); loadMessages(true); }} className="btn-ghost mt-4">
          Reintentar
        </button>
      </div>
    );
  }

  const name = conversation?.client_name || conversation?.contact_name || conversation?.phone || '—';

  return (
    <div className="flex flex-col" style={{ height: 'calc(100dvh - 7.5rem)' }}>
      {/* Header */}
      <div className="flex-shrink-0 px-4 pt-4 pb-3 flex items-center gap-2 border-b border-gray-100 dark:border-gray-700">
        <button
          onClick={() => nav('/conversations')}
          className="flex items-center text-blue-700 dark:text-blue-400 font-medium -ml-1 p-1"
        >
          <ChevronLeft size={22} />
        </button>
        <div className="flex-1 min-w-0">
          <div className="font-bold text-gray-900 dark:text-white text-sm truncate">{name}</div>
          {conversation?.phone && (
            <div className="text-xs text-gray-500 dark:text-gray-400">{conversation.phone}</div>
          )}
        </div>
        {conversation?.client_id && (
          <button
            onClick={() => nav(`/clients/${conversation.client_id}`)}
            className="btn-ghost !py-2 !px-3 flex items-center gap-1.5 text-xs flex-shrink-0"
          >
            <User size={14} /> Ficha
          </button>
        )}
        <button
          onClick={toggleStatus}
          disabled={statusUpdating}
          className="btn-ghost !py-2 !px-3 flex items-center gap-1.5 text-xs flex-shrink-0"
        >
          {conversation?.status === 'closed' ? <Unlock size={14} /> : <Lock size={14} />}
          {conversation?.status === 'closed' ? 'Reabrir' : 'Cerrar'}
        </button>
      </div>

      {/* Messages */}
      <div
        ref={chatRef}
        onScroll={handleChatScroll}
        className="flex-1 overflow-y-auto px-4 py-3 no-scrollbar"
      >
        {messages.length === 0 ? (
          <div className="flex flex-col items-center justify-center h-full text-gray-400 dark:text-gray-500 text-sm gap-2">
            <span>Sin mensajes aún</span>
          </div>
        ) : (
          <div className="space-y-1">
            {messages.map((m, i) => {
              const isOut    = m.direction === 'outbound';
              const dateStr  = fmtDate(m.created_at || m.received_at);
              const prevDate = i > 0 ? fmtDate(messages[i - 1].created_at || messages[i - 1].received_at) : null;
              const showDate = dateStr !== prevDate;

              return (
                <React.Fragment key={m.id}>
                  {showDate && (
                    <div className="flex items-center justify-center py-2">
                      <span className="text-[11px] text-gray-400 dark:text-gray-500 bg-gray-100 dark:bg-gray-800 px-3 py-0.5 rounded-full">
                        {dateStr}
                      </span>
                    </div>
                  )}
                  <div className={`flex ${isOut ? 'justify-end' : 'justify-start'} mb-0.5`}>
                    <div className={`max-w-[78%] px-3.5 py-2 rounded-2xl text-sm
                      ${isOut
                        ? `bg-orange-500 text-white rounded-br-md ${m.status === 'failed' ? 'opacity-60' : ''}`
                        : 'bg-white dark:bg-gray-700 text-gray-900 dark:text-gray-100 shadow-sm rounded-bl-md border border-gray-100 dark:border-gray-600'
                      }`}
                    >
                      <p className={`whitespace-pre-wrap break-words leading-snug ${!m.body && m.type !== 'text' ? 'italic opacity-80' : ''}`}>
                        {m.body || (m.type && m.type !== 'text' ? mediaLabel(m.type) : '')}
                      </p>
                      <div className={`flex items-center gap-1 mt-1 ${isOut ? 'justify-end' : 'justify-start'}`}>
                        <span className={`text-[10px] leading-none ${isOut ? 'text-orange-100' : 'text-gray-400 dark:text-gray-500'}`}>
                          {fmtTime(m.created_at || m.received_at)}
                        </span>
                        {isOut && (
                          <>
                            <MessageStatus status={m.status} />
                            {m.status === 'failed' && (
                              <span className="text-[10px] text-red-200 font-medium">Fallido</span>
                            )}
                          </>
                        )}
                      </div>
                    </div>
                  </div>
                </React.Fragment>
              );
            })}
          </div>
        )}
        <div ref={messagesEndRef} />
      </div>

      {/* Send error */}
      {sendError && (
        <div className="flex-shrink-0 mx-4 mb-2 p-3 bg-red-50 dark:bg-red-900/20 border border-red-200 dark:border-red-800 rounded-xl text-xs text-red-600 dark:text-red-400 flex items-start gap-2">
          <AlertCircle size={14} className="flex-shrink-0 mt-0.5" />
          <span className="flex-1">{sendError}</span>
          <button
            onClick={() => setSendError(null)}
            className="flex-shrink-0 text-red-400 hover:text-red-600 dark:hover:text-red-300 font-bold"
          >
            ✕
          </button>
        </div>
      )}

      {/* Input */}
      <div className="flex-shrink-0 px-4 py-3 bg-white dark:bg-gray-800 border-t border-gray-200 dark:border-gray-700">
        <div className="flex items-end gap-2">
          <textarea
            ref={textareaRef}
            className="input flex-1 !py-2.5 resize-none text-sm leading-snug"
            style={{ minHeight: '42px', maxHeight: '120px', overflowY: 'auto' }}
            placeholder="Escribe un mensaje…"
            value={text}
            onChange={e => {
              setText(e.target.value);
              setSendError(null);
              autoResizeTextarea();
            }}
            onKeyDown={handleKeyDown}
            disabled={sending}
            rows={1}
          />
          <button
            onClick={handleSend}
            disabled={!text.trim() || sending}
            className={`flex-shrink-0 w-11 h-11 rounded-xl flex items-center justify-center transition-colors touch-manipulation
              ${!text.trim() || sending
                ? 'bg-gray-100 dark:bg-gray-700 text-gray-300 dark:text-gray-500 cursor-not-allowed'
                : 'bg-orange-500 hover:bg-orange-600 active:bg-orange-700 text-white'}`}
          >
            <Send size={18} />
          </button>
        </div>
      </div>
    </div>
  );
}
