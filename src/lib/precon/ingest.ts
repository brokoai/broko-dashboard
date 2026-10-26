import { createHash } from "node:crypto";
import { chunkPages } from "./chunk";
import { ExtractError, extractContent } from "./extract";
import { checkContent, extOf } from "./files";
import type { FileStore, PreconRepo } from "./repo";
import { DETAIL_TEXT, DOC_KIND_LABEL, EXTRACTOR_VERSION, type PreconDocument, type TextChunk } from "./types";

// The ingestion pipeline: stored file -> verified bytes -> extracted text -> chunks with page numbers -> stored chunks.
// A document becomes "processed" ONLY after its chunks are stored. Every failure becomes status "failed" with a fixed, user-safe
// reason (never raw error text); an administrator can retry. Re-running is safe: chunks are replaced, never duplicated.

export interface IngestDeps {
  repo: PreconRepo;
  files: FileStore;
  log?: (e: unknown) => void;
}

const sha256 = (b: Uint8Array) => createHash("sha256").update(b).digest("hex");

async function fail(deps: IngestDeps, id: string, detail: keyof typeof DETAIL_TEXT, attempts: number): Promise<PreconDocument> {
  await deps.repo.updateDocument(id, { status: "failed", status_detail: detail, attempts, processed_at: null });
  return (await deps.repo.getDocument(id))!;
}

export async function ingestDocument(deps: IngestDeps, documentId: string): Promise<PreconDocument> {
  const { repo, files } = deps;
  const doc = await repo.getDocument(documentId);
  const info = await repo.getDocumentStorage(documentId);
  if (!doc || !info) throw new Error("Document not found.");
  const attempts = doc.attempts + 1;
  await repo.updateDocument(documentId, { status: "processing", status_detail: null, attempts });

  let bytes: Uint8Array | null;
  try {
    bytes = await files.download(info.storage_path);
  } catch (e) {
    (deps.log ?? console.error)("[precon] download failed", e);
    return fail(deps, documentId, "storage_error", attempts);
  }
  if (!bytes) return fail(deps, documentId, "storage_missing", attempts);

  const ext = extOf(info.filename);
  if (!ext) return fail(deps, documentId, "unsupported_type", attempts);
  const content = checkContent(ext, bytes);
  if (!content.ok) return fail(deps, documentId, content.code, attempts);

  const hash = sha256(bytes);
  const same = await repo.findDocumentByHash(info.project_id, hash);
  if (same && same.id !== documentId) return fail(deps, documentId, "duplicate_content", attempts);

  let pages: { page: number | null; text: string }[];
  let pageCount: number | null;
  let kind: "text" | "image";
  try {
    const out = await extractContent(ext, bytes);
    ({ pages, page_count: pageCount, kind } = out);
  } catch (e) {
    if (e instanceof ExtractError) return fail(deps, documentId, e.code, attempts);
    (deps.log ?? console.error)("[precon] extract failed", e);
    return fail(deps, documentId, "extract_failed", attempts);
  }

  let chunks: TextChunk[];
  let truncated = false;
  if (kind === "image") {
    // An image has no text to read. Only its title and kind are findable, and the document says so ("not_indexable").
    chunks = [{ page: null, text: `${doc.title} (${DOC_KIND_LABEL[doc.kind]}, file ${doc.filename})` }];
  } else {
    ({ chunks, truncated } = chunkPages(pages));
    if (chunks.length === 0) return fail(deps, documentId, "no_text", attempts);
  }

  try {
    await repo.replaceChunks(documentId, info.project_id, chunks);
  } catch (e) {
    (deps.log ?? console.error)("[precon] storing chunks failed", e);
    return fail(deps, documentId, "extract_failed", attempts);
  }
  await repo.updateDocument(documentId, {
    status: "processed",
    status_detail: kind === "image" ? "not_indexable" : truncated ? "truncated" : null,
    sha256: hash,
    page_count: pageCount,
    chunk_count: chunks.length,
    extractor_version: EXTRACTOR_VERSION,
    attempts,
    processed_at: new Date().toISOString(),
  });
  return (await repo.getDocument(documentId))!;
}
