/**
 * Files the server keeps on its own disk (DATA_DIR): check-in photos, receipt photos.
 * Stored as "<folder>/<yyyy-mm>/<uuid>.<ext>"; callers keep only "<yyyy-mm>/<uuid>.<ext>".
 */
import { randomUUID } from "node:crypto";
import { mkdir, writeFile, readFile } from "node:fs/promises";
import path from "node:path";
import { toLocal } from "./ai/helpers";

export const DATA_DIR = path.resolve(process.env.DATA_DIR || path.join(process.cwd(), "data"));
export type Folder = "attendance" | "money";

const TYPES = { jpeg: { ext: "jpg", mime: "image/jpeg" }, png: { ext: "png", mime: "image/png" }, pdf: { ext: "pdf", mime: "application/pdf" } } as const;
const REL_RE = /^\d{4}-\d{2}\/[0-9a-f-]{36}\.(jpg|png|pdf)$/;

export class FileError extends Error {}

/** Save a data: URL. `allowed` limits the formats (JPEG only for kiosk photos). */
export async function saveDataUrl(folder: Folder, dataUrl: unknown, opts: { allowed?: (keyof typeof TYPES)[]; maxBytes?: number } = {}): Promise<string> {
  const allowed = opts.allowed ?? ["jpeg"];
  const m = typeof dataUrl === "string" ? /^data:(image\/jpeg|image\/png|application\/pdf);base64,([A-Za-z0-9+/=]+)$/.exec(dataUrl) : null;
  const kind = m ? (m[1] === "image/jpeg" ? "jpeg" : m[1] === "image/png" ? "png" : "pdf") : null;
  if (!m || !kind || !allowed.includes(kind)) throw new FileError(allowed.length === 1 ? "Фото должно быть в формате JPEG" : "Поддерживаются JPEG, PNG и PDF");
  const buf = Buffer.from(m[2], "base64");
  if (buf.length < 500 || buf.length > (opts.maxBytes ?? 1_500_000)) throw new FileError("Неверный размер файла");
  const rel = `${toLocal(new Date()).date.slice(0, 7)}/${randomUUID()}.${TYPES[kind].ext}`;
  await mkdir(path.join(DATA_DIR, folder, rel.slice(0, 7)), { recursive: true });
  await writeFile(path.join(DATA_DIR, folder, rel), buf);
  return rel;
}

/** Read a stored file; null when the name is not one we issued or the file is gone. */
export async function readStored(folder: Folder, rel: string): Promise<{ buf: Buffer; mime: string } | null> {
  if (!REL_RE.test(rel)) return null;
  try {
    const buf = await readFile(path.join(DATA_DIR, folder, rel));
    const ext = rel.split(".").pop();
    return { buf, mime: ext === "png" ? "image/png" : ext === "pdf" ? "application/pdf" : "image/jpeg" };
  } catch { return null; }
}

/** Save raw bytes (e.g. a photo downloaded from Telegram). */
export async function saveBuffer(folder: Folder, buf: Buffer, ext: "jpg" | "png" | "pdf"): Promise<string> {
  if (buf.length < 500 || buf.length > 8_000_000) throw new FileError("Неверный размер файла");
  const rel = `${toLocal(new Date()).date.slice(0, 7)}/${randomUUID()}.${ext}`;
  await mkdir(path.join(DATA_DIR, folder, rel.slice(0, 7)), { recursive: true });
  await writeFile(path.join(DATA_DIR, folder, rel), buf);
  return rel;
}
