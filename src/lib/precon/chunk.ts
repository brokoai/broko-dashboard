import type { TextChunk } from "./types";

export const CHUNK_TARGET = 1000;
export const CHUNK_OVERLAP = 150;
export const MAX_CHUNKS_PER_DOCUMENT = 2000;

/** Collapses whitespace and strips control characters. Page structure is kept by chunking per page, not by newlines. */
export function normalizeText(s: string): string {
  return s.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]+/g, " ").replace(/[ \t ]+/g, " ").replace(/\s*\n\s*/g, "\n").trim();
}

/**
 * Splits pages into overlapping chunks of about CHUNK_TARGET characters, preferring paragraph, line then sentence boundaries.
 * Every chunk keeps the page it came from, so an answer can cite "page 3". Returns at most MAX_CHUNKS_PER_DOCUMENT chunks and
 * says whether it had to stop early.
 */
export function chunkPages(pages: { page: number | null; text: string }[]): { chunks: TextChunk[]; truncated: boolean } {
  const chunks: TextChunk[] = [];
  for (const p of pages) {
    const text = normalizeText(p.text);
    let start = 0;
    while (start < text.length) {
      if (chunks.length >= MAX_CHUNKS_PER_DOCUMENT) return { chunks, truncated: true };
      let end = Math.min(text.length, start + CHUNK_TARGET);
      if (end < text.length) {
        const from = Math.floor(CHUNK_TARGET * 0.6);
        const window = text.slice(start + from, end);
        const rel = Math.max(window.lastIndexOf("\n\n"), window.lastIndexOf("\n"), window.lastIndexOf(". "), window.lastIndexOf("; "));
        if (rel >= 0) end = start + from + rel + 1;
      }
      const piece = text.slice(start, end).trim();
      if (piece) chunks.push({ page: p.page, text: piece });
      if (end >= text.length) break;
      start = Math.max(end - CHUNK_OVERLAP, start + 1);
    }
  }
  return { chunks, truncated: false };
}
