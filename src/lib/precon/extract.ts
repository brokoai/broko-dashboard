import { parseCsv, SheetLimitError, MAX_COLS, MAX_ROWS } from "./csv";
import { MAX_UNZIPPED_BYTES, zipUncompressedSize, type FileExt } from "./files";
import { DETAIL_TEXT } from "./types";

// Text extraction for the ingestion pipeline. Pure functions over bytes: no storage, no database, no network.
// Supported: PDF (per page), plain text, CSV and XLSX (every row becomes a searchable line with its column names).
// Images are stored and displayed but contain no extractable text: they come back with `kind: "image"` and no pages.

export const MAX_PDF_PAGES = 500;
export const MAX_TEXT_CHARS = 2_000_000;
const PDF_TIMEOUT_MS = 25_000;

export interface Extracted {
  kind: "text" | "image";
  pages: { page: number | null; text: string }[];
  /** PDF page count; null when the format has no pages. */
  page_count: number | null;
}

export class ExtractError extends Error {
  constructor(readonly code: keyof typeof DETAIL_TEXT) {
    super(DETAIL_TEXT[code]);
  }
}

const decode = (bytes: Uint8Array) => new TextDecoder("utf-8", { fatal: false }).decode(bytes);

/** Renders one cell for indexing. Dates as YYYY-MM-DD; numbers without floating-point noise. */
export function cellText(v: unknown): string {
  if (v === null || v === undefined) return "";
  if (v instanceof Date) return Number.isNaN(v.getTime()) ? "" : v.toISOString().slice(0, 10);
  if (typeof v === "number") return Number.isFinite(v) ? String(Math.round(v * 1e6) / 1e6) : "";
  return String(v).replace(/\s+/g, " ").trim();
}

/** One searchable line per data row: "Sheet, row 4: Unit: 1204; Bedrooms: 2; Price: 799000". Empty cells are skipped. */
export function sheetToText(label: string, rows: unknown[][]): string {
  const headerAt = rows.findIndex((r) => r.some((c) => cellText(c) !== ""));
  if (headerAt < 0) return "";
  const headers = rows[headerAt].map((h, i) => cellText(h) || `Column ${i + 1}`);
  const lines: string[] = [];
  for (let i = headerAt + 1; i < rows.length; i++) {
    const parts = rows[i].map((c, j) => [headers[j] ?? `Column ${j + 1}`, cellText(c)] as const).filter(([, v]) => v !== "").map(([h, v]) => `${h}: ${v}`);
    if (parts.length) lines.push(`${label}, row ${i + 1}: ${parts.join("; ")}`);
  }
  return lines.join("\n");
}

async function extractPdf(bytes: Uint8Array): Promise<Extracted> {
  const { getDocumentProxy, extractText } = await import("unpdf");
  const work = (async () => {
    // pdfjs transfers/detaches the buffer it is given: always hand it a copy.
    const pdf = await getDocumentProxy(new Uint8Array(bytes));
    if (pdf.numPages > MAX_PDF_PAGES) throw new ExtractError("too_complex");
    const { totalPages, text } = await extractText(pdf, { mergePages: false });
    const pages = (text as string[]).map((t, i) => ({ page: i + 1, text: t }));
    return { totalPages, pages };
  })();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const limit = new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new ExtractError("too_complex")), PDF_TIMEOUT_MS); });
  try {
    const { totalPages, pages } = await Promise.race([work, limit]);
    if (pages.reduce((n, p) => n + p.text.trim().length, 0) === 0) throw new ExtractError("no_text");
    return { kind: "text", pages: pages.filter((p) => p.text.trim()), page_count: totalPages };
  } finally {
    clearTimeout(timer);
    work.catch(() => undefined); // a late failure after the timeout must not become an unhandled rejection
  }
}

async function extractXlsx(bytes: Uint8Array): Promise<Extracted> {
  const claimed = zipUncompressedSize(bytes);
  if (claimed === null || claimed > MAX_UNZIPPED_BYTES) throw new ExtractError("too_complex");
  const { default: readXlsxFile } = await import("read-excel-file/node");
  const sheets = await readXlsxFile(Buffer.from(bytes));
  let rowsSeen = 0;
  const texts: string[] = [];
  for (const s of sheets) {
    rowsSeen += s.data.length;
    if (rowsSeen > MAX_ROWS || s.data.some((r) => r.length > MAX_COLS)) throw new ExtractError("too_complex");
    const t = sheetToText(s.sheet, s.data);
    if (t) texts.push(t);
  }
  const text = texts.join("\n");
  if (!text) throw new ExtractError("no_text");
  return { kind: "text", pages: [{ page: null, text }], page_count: null };
}

export async function extractContent(ext: FileExt, bytes: Uint8Array): Promise<Extracted> {
  try {
    switch (ext) {
      case "jpg": case "png": case "webp":
        return { kind: "image", pages: [], page_count: null };
      case "txt": {
        const text = decode(bytes).slice(0, MAX_TEXT_CHARS);
        if (!text.trim()) throw new ExtractError("no_text");
        return { kind: "text", pages: [{ page: null, text }], page_count: null };
      }
      case "csv": {
        const text = sheetToText("Sheet", parseCsv(decode(bytes)));
        if (!text) throw new ExtractError("no_text");
        return { kind: "text", pages: [{ page: null, text: text.slice(0, MAX_TEXT_CHARS) }], page_count: null };
      }
      case "xlsx": return await extractXlsx(bytes);
      case "pdf": return await extractPdf(bytes);
    }
  } catch (e) {
    if (e instanceof ExtractError) throw e;
    if (e instanceof SheetLimitError) throw new ExtractError("too_complex");
    throw new ExtractError("extract_failed"); // the underlying error is deliberately not surfaced (it can echo file content)
  }
}

/** Raw rows of the first non-empty sheet, for the inventory import. CSV and XLSX only. */
export async function readTable(ext: FileExt, bytes: Uint8Array): Promise<{ rows: unknown[][]; sheet: string | null }> {
  try {
    if (ext === "csv") return { rows: parseCsv(decode(bytes)), sheet: null };
    if (ext === "xlsx") {
      const claimed = zipUncompressedSize(bytes);
      if (claimed === null || claimed > MAX_UNZIPPED_BYTES) throw new ExtractError("too_complex");
      const { default: readXlsxFile } = await import("read-excel-file/node");
      const sheets = await readXlsxFile(Buffer.from(bytes));
      const first = sheets.find((s) => s.data.some((r) => r.some((c) => cellText(c) !== "")));
      if (!first) throw new ExtractError("no_text");
      if (first.data.length > MAX_ROWS || first.data.some((r) => r.length > MAX_COLS)) throw new ExtractError("too_complex");
      return { rows: first.data, sheet: first.sheet };
    }
  } catch (e) {
    if (e instanceof ExtractError) throw e;
    if (e instanceof SheetLimitError) throw new ExtractError("too_complex");
    throw new ExtractError("extract_failed");
  }
  throw new ExtractError("unsupported_type");
}
