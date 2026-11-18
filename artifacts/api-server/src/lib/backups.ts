/** Reads the backup folder written by deploy/backup.sh, shows its state and warns the owner when backups stop. */
import { readdir, readFile, stat } from "node:fs/promises";
import path from "node:path";
import { notifyStaff } from "./telegramBot";
import { logger } from "./logger";

export const STALE_HOURS = 36;

export function backupAgeHours(last: Date | null, now = new Date()) {
  return last ? Math.round(((now.getTime() - last.getTime()) / 3600_000) * 10) / 10 : null;
}

export async function backupStatus(now = new Date()) {
  const dir = process.env.BACKUP_DIR;
  if (!dir) return { configured: false as const };
  try {
    const names = (await readdir(dir)).filter((n) => /^(db-.*\.dump|files-.*\.tgz)$/.test(n));
    const files = await Promise.all(names.map(async (n) => { const s = await stat(path.join(dir, n)); return { name: n, kind: n.startsWith("db-") ? "db" : "files", size: s.size, at: s.mtime }; }));
    files.sort((a, b) => b.at.getTime() - a.at.getTime());
    let last: Date | null = null;
    try { const t = (await readFile(path.join(dir, "last-backup.txt"), "utf8")).trim(); const d = new Date(t); if (!Number.isNaN(d.getTime())) last = d; } catch { /* no marker yet */ }
    last ??= files[0]?.at ?? null;
    const age = backupAgeHours(last, now);
    return { configured: true as const, dir, lastBackupAt: last, ageHours: age, ok: age != null && age <= STALE_HOURS, files: files.slice(0, 40), totalSize: files.reduce((s, f) => s + f.size, 0) };
  } catch (err) {
    return { configured: true as const, dir, error: `Папка с копиями недоступна: ${(err as Error).message}`, ok: false, files: [], lastBackupAt: null, ageHours: null, totalSize: 0 };
  }
}

let lastAlert = 0;
export async function checkBackups() {
  const s = await backupStatus();
  if (!s.configured || s.ok || Date.now() - lastAlert < 24 * 3600_000) return;
  lastAlert = Date.now();
  const why = "error" in s && s.error ? s.error : s.ageHours == null ? "резервных копий ещё нет" : `последняя копия была ${Math.round(s.ageHours)} ч назад`;
  await notifyStaff(`⚠️ Резервное копирование не работает: ${why}. Проверьте сервис backup на сервере ресторана (docs/BACKUP.md).`, ["super_admin"]);
}

let timer: NodeJS.Timeout | null = null;
export function startBackupWatch() {
  if (timer || !process.env.BACKUP_DIR) return;
  // First look an hour after start (the backup service makes its first copy on start-up).
  timer = setInterval(() => { checkBackups().catch((err) => logger.error({ err }, "backup check failed")); }, 3600_000);
  timer.unref();
}
