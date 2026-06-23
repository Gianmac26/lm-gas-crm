#!/bin/bash
# Iniciador del CRM L&M Gas
DIR="$(cd "$(dirname "$0")" && pwd)"

echo "🔥 Iniciando L&M Gas CRM..."
echo ""

# Matar procesos previos en los puertos
lsof -ti:3001 | xargs kill -9 2>/dev/null
lsof -ti:5173 | xargs kill -9 2>/dev/null

# Iniciar servidor Express
cd "$DIR"
node server.js &
SERVER_PID=$!
echo "✅ Servidor API iniciado (puerto 3001)"

# Iniciar cliente Vite
cd "$DIR/client"
npm run dev -- --host &
VITE_PID=$!
echo "✅ App web iniciada (puerto 5173)"

sleep 2
echo ""
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo "🌐 Abrir en el celular: http://$(ipconfig getifaddr en0):5173"
echo "🖥  Abrir en esta compu: http://localhost:5173"
echo "🔑 PIN de acceso: 1234"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo ""
echo "Presiona Ctrl+C para detener"

# Esperar
wait $SERVER_PID $VITE_PID
