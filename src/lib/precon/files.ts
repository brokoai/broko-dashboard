import { DETAIL_TEXT, type DocKind } from "./types";

// Upload rules. They run in the browser (fast feedback) AND on the server (authority); the server also checks the file's actual
// bytes, so a renamed file cannot pass as another type.

export const MAX_UPLOAD_BYTES = 25 * 1024 * 1024;

export type FileExt = "pdf" | "jpg" | "png" | "webp" | "txt" | "csv" | "xlsx";

interface TypeRule { mime: string; accepts: string[]; kinds: DocKind[] }
export const FILE_TYPES: Record<FileExt, TypeRule> = {
  pdf: { mime: "application/pdf", accepts: ["application/pdf"], kinds: ["brochure", "floor_plan", "pricing_sheet", "document", "other"] },
  jpg: { mime: "image/jpeg", accepts: ["image/jpeg"], kinds: ["rendering", "floor_plan", "other"] },
  png: { mime: "image/png", accepts: ["image/png"], kinds: ["rendering", "floor_plan", "other"] },
  webp: { mime: "image/webp", accepts: ["image/webp"], kinds: ["rendering", "floor_plan", "other"] },
  txt: { mime: "text/plain", accepts: ["text/plain"], kinds: ["document", "other"] },
  // Windows browsers label .csv as application/vnd.ms-excel; an empty type is common too. The extension and the content decide.
  csv: { mime: "text/csv", accepts: ["text/csv", "application/vnd.ms-excel", "text/plain", ""], kinds: ["pricing_sheet", "inventory_sheet", "document", "other"] },
  xlsx: { mime: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", accepts: ["application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", ""], kinds: ["pricing_sheet", "inventory_sheet", "document", "other"] },
};
/** The `accept` attribute for file pickers (including the phone camera roll). */
export const ACCEPT_ATTR = ".pdf,.jpg,.jpeg,.png,.webp,.txt,.csv,.xlsx";
export const ALLOWED_MIME_TYPES = Object.values(FILE_TYPES).map((t) => t.mime);

export function extOf(filename: string): FileExt | null {
  const m = /\.([A-Za-z0-9]{1,5})$/.exec(filename.trim());
  const e = m?.[1].toLowerCase();
  if (e === "jpeg") return "jpg";
  return e && e in FILE_TYPES ? (e as FileExt) : null;
}

export type FileCheck = { ok: true; ext: FileExt; mime: string } | { ok: false; code: keyof typeof DETAIL_TEXT; message: string };
const bad = (code: keyof typeof DETAIL_TEXT, message = DETAIL_TEXT[code]): FileCheck => ({ ok: false, code, message });

/** Metadata-only check, usable in the browser and before any bytes exist. */
export function checkUploadMeta(filename: string, declaredMime: string, size: number, kind?: DocKind): FileCheck {
  const ext = extOf(filename);
  if (!ext) return bad("unsupported_type", "Unsupported file type. Use PDF, JPG, PNG, WebP, TXT, CSV or XLSX.");
  if (!Number.isFinite(size) || size <= 0) return bad("empty");
  if (size > MAX_UPLOAD_BYTES) return bad("too_large");
  const rule = FILE_TYPES[ext];
  if (!rule.accepts.includes(declaredMime.toLowerCase())) return bad("content_mismatch", "The file's type does not match its extension.");
  if (kind && !rule.kinds.includes(kind)) return bad("unsupported_type", `A .${ext} file cannot be filed as that kind of document.`);
  return { ok: true, ext, mime: rule.mime };
}

const startsWith = (b: Uint8Array, sig: number[], at = 0) => sig.every((v, i) => b[at + i] === v);

/** Server-side content check: the bytes must look like the extension claims. */
export function checkContent(ext: FileExt, bytes: Uint8Array): FileCheck {
  if (bytes.byteLength === 0) return bad("empty");
  if (bytes.byteLength > MAX_UPLOAD_BYTES) return bad("too_large");
  const ok =
    ext === "pdf" ? startsWith(bytes, [0x25, 0x50, 0x44, 0x46, 0x2d]) :
    ext === "jpg" ? startsWith(bytes, [0xff, 0xd8, 0xff]) :
    ext === "png" ? startsWith(bytes, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]) :
    ext === "webp" ? startsWith(bytes, [0x52, 0x49, 0x46, 0x46]) && startsWith(bytes, [0x57, 0x45, 0x42, 0x50], 8) :
    ext === "xlsx" ? startsWith(bytes, [0x50, 0x4b, 0x03, 0x04]) :
    !bytes.subarray(0, 4096).includes(0); // txt / csv: no NUL bytes (binary)
  return ok ? { ok: true, ext, mime: FILE_TYPES[ext].mime } : bad("content_mismatch");
}

/**
 * Zip bomb guard for .xlsx: sum the uncompressed sizes the archive CLAIMS in its central directory before anything is inflated.
 * Returns null when the directory cannot be read (treated as unsafe by the caller).
 */
export function zipUncompressedSize(bytes: Uint8Array): number | null {
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const min = Math.max(0, bytes.byteLength - 22 - 0xffff);
  let eocd = -1;
  for (let i = bytes.byteLength - 22; i >= min; i--) if (dv.getUint32(i, true) === 0x06054b50) { eocd = i; break; }
  if (eocd < 0) return null;
  const count = dv.getUint16(eocd + 10, true);
  let off = dv.getUint32(eocd + 16, true);
  let total = 0;
  for (let n = 0; n < count; n++) {
    if (off + 46 > bytes.byteLength || dv.getUint32(off, true) !== 0x02014b50) return null;
    total += dv.getUint32(off + 24, true);
    off += 46 + dv.getUint16(off + 28, true) + dv.getUint16(off + 30, true) + dv.getUint16(off + 32, true);
  }
  return total;
}
export const MAX_UNZIPPED_BYTES = 150 * 1024 * 1024;

/** Display filename: no path, no control characters, bounded. Keeps the user's wording; the storage name is separate. */
export function displayFilename(name: string): string {
  const base = name.replace(/\\/g, "/").split("/").pop() ?? "";
  const clean = base.replace(/[\u0000-\u001f\u007f]+/g, "").replace(/\s+/g, " ").trim();
  return (clean || "file").slice(-200);
}

/** Storage-safe name: [A-Za-z0-9._-], lowercase extension kept, at most 120 characters. */
export function storageFilename(name: string): string {
  const base = displayFilename(name);
  const dot = base.lastIndexOf(".");
  const ext = dot > 0 ? base.slice(dot + 1).toLowerCase().replace(/[^a-z0-9]/g, "").slice(0, 5) : "";
  const stem = (dot > 0 ? base.slice(0, dot) : base).normalize("NFKD").replace(/[^A-Za-z0-9._-]+/g, "_").replace(/^[._-]+|[._-]+$/g, "").replace(/_{2,}/g, "_");
  const safeStem = (stem || "file").slice(0, 100);
  return ext ? `${safeStem}.${ext}` : safeStem;
}

/** projects/<project id>/<document id>/<safe name>. A fresh document id per upload, so identical filenames never collide. */
export const storagePath = (projectId: string, docId: string, filename: string): string => `projects/${projectId}/${docId}/${storageFilename(filename)}`;

export const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function humanSize(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(n < 10240 ? 1 : 0)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}
