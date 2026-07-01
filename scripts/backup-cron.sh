#!/bin/bash
#
# Envoltorio para la tarea programada (launchd) de respaldo semanal.
#   1. Genera y verifica un respaldo local (scripts/backup-db.js -> CRM-backups/).
#   2. Copia el respaldo más reciente a Google Drive (off-site).
# Todo queda registrado en ~/Library/Logs/lmgas-backup.log
#
# launchd corre con un entorno mínimo, por eso fijamos PATH explícitamente.

export PATH="/usr/local/bin:/Users/gianmac/.turso:/usr/bin:/bin:/usr/sbin:/sbin"

PROJECT="/Users/gianmac/L&M Distribuidora de gas"
DRIVE_DEST="/Users/gianmac/Library/CloudStorage/GoogleDrive-veretisac@gmail.com/Mi unidad/Respaldos LM Gas"
LOG="$HOME/Library/Logs/lmgas-backup.log"

echo "" >> "$LOG"
echo "════════ $(date '+%Y-%m-%d %H:%M:%S') ════════" >> "$LOG"

cd "$PROJECT" || { echo "ERROR: no se encontró el proyecto en $PROJECT" >> "$LOG"; exit 1; }

# 1) Respaldo local (garantizado)
node scripts/backup-db.js >> "$LOG" 2>&1
STATUS=$?
if [ $STATUS -ne 0 ]; then
  echo "ERROR: el respaldo local falló (código $STATUS)." >> "$LOG"
  exit $STATUS
fi

# 2) Copia off-site a Google Drive (mejor esfuerzo: si Drive no está listo, no rompe nada)
NEWEST=$(ls -t "$PROJECT"/CRM-backups/*.sql 2>/dev/null | head -1)
if [ -n "$NEWEST" ]; then
  if mkdir -p "$DRIVE_DEST" 2>>"$LOG" && cp "$NEWEST" "$DRIVE_DEST"/ 2>>"$LOG"; then
    echo "✓ Copiado a Google Drive: $DRIVE_DEST/$(basename "$NEWEST")" >> "$LOG"
  else
    echo "⚠ AVISO: no se pudo copiar a Google Drive (¿Drive apagado o sincronizando?). El respaldo local SÍ se guardó en CRM-backups/." >> "$LOG"
  fi
fi

echo "Fin del respaldo." >> "$LOG"
