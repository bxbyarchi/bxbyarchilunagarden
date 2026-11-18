#!/bin/sh
# Nightly backup of the Luna Garden database and server files (check-in photos, receipts).
# Runs inside the "backup" service of docker-compose.yml. Output: ./backups on the host.
#   db-YYYY-MM-DD_HHMM.dump     — pg_dump custom format (restore with pg_restore, see docs/BACKUP.md)
#   files-YYYY-MM-DD_HHMM.tgz   — contents of DATA_DIR
#   last-backup.txt             — time of the last successful run (the app shows it in Settings)
set -eu
OUT="${BACKUP_OUT:-/backups}"
DATA="${DATA_SRC:-/data}"
KEEP_DAYS="${KEEP_DAYS:-14}"
BACKUP_HOUR="${BACKUP_HOUR:-4}"          # local Bishkek time (UTC+6)
UTC_HOUR=$(( (BACKUP_HOUR + 24 - 6) % 24 ))

run() {
  ts=$(date -u -d "@$(( $(date -u +%s) + 6*3600 ))" +%Y-%m-%d_%H%M 2>/dev/null || date -u +%Y-%m-%d_%H%M)
  echo "[backup] start $ts"
  pg_dump -Fc -f "$OUT/.db.tmp" && mv "$OUT/.db.tmp" "$OUT/db-$ts.dump"
  if [ -d "$DATA" ]; then tar -czf "$OUT/.files.tmp" -C "$DATA" . && mv "$OUT/.files.tmp" "$OUT/files-$ts.tgz"; fi
  find "$OUT" -maxdepth 1 \( -name 'db-*.dump' -o -name 'files-*.tgz' \) -mtime +"$KEEP_DAYS" -delete
  date -u +%Y-%m-%dT%H:%M:%SZ > "$OUT/last-backup.txt"
  echo "[backup] done $ts"
}

mkdir -p "$OUT"
if [ "${RUN_ONCE:-}" = "1" ]; then run; exit 0; fi
# First run right away if there is no backup from the last 20 hours.
if [ -z "$(find "$OUT" -maxdepth 1 -name 'db-*.dump' -mmin -1200 2>/dev/null)" ]; then run || echo "[backup] FAILED"; fi
while true; do
  now=$(date -u +%s)
  next=$(( now - now % 86400 + UTC_HOUR * 3600 ))
  [ "$next" -le "$now" ] && next=$(( next + 86400 ))
  sleep $(( next - now ))
  run || echo "[backup] FAILED"
done
