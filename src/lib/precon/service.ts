import { randomUUID } from "node:crypto";
import type { ZodType } from "zod";
import { UserFacingError } from "@/lib/backend/types";
import type { Profile } from "@/lib/types";
import { checkContent, checkUploadMeta, displayFilename, extOf, storagePath } from "./files";
import { IMPORT_FIELDS, previewImport, type ColumnMapping, type ImportField, type ImportPreview } from "./inventory-import";
import { readTable, ExtractError } from "./extract";
import { ingestDocument } from "./ingest";
import { canManagePrecon } from "./permissions";
import type { FileStore, PreconRepo } from "./repo";
import { beginUploadSchema, finishUploadSchema, importCommitSchema, projectInputSchema, projectPatchSchema, uuid } from "./schemas";
import { DETAIL_TEXT, type AuditEntry, type InventoryInput, type PreconDocument, type PreconProject } from "./types";

// Orchestration behind the Pre-Construction server actions, free of Next.js so every rule can be tested directly.
// Each function authorizes first, validates its input, and only then touches the repository or storage.

export interface PreconContext {
  user: Profile;
  repo: PreconRepo | undefined;
  files: FileStore | null;
  log?: (e: unknown) => void;
}

const READ_ONLY = "The demo is read-only: Pre-Construction records cannot be changed here.";

function repoOf(ctx: PreconContext): PreconRepo {
  if (!ctx.repo) throw new UserFacingError("Pre-Construction is not connected to this backend.");
  return ctx.repo;
}

/** Throws unless this user may write. The database refuses the same writes independently. */
function manager(ctx: PreconContext): PreconRepo {
  const repo = repoOf(ctx);
  if (!repo.writable) throw new UserFacingError(READ_ONLY);
  if (!canManagePrecon(ctx.user)) throw new UserFacingError("You do not have permission to do that.");
  return repo;
}

function parse<T>(schema: ZodType<T>, raw: unknown): T {
  const r = schema.safeParse(raw);
  if (!r.success) throw new UserFacingError(r.error.issues[0]?.message || "Invalid request.");
  return r.data;
}

/** The audit trail is best effort once a change has happened: a failure is logged, never allowed to undo or hide the change. */
async function audit(ctx: PreconContext, entry: AuditEntry): Promise<void> {
  try {
    await repoOf(ctx).recordAudit(entry);
  } catch (e) {
    (ctx.log ?? console.error)("[precon] audit failed", e);
  }
}

const needFiles = (ctx: PreconContext): FileStore => {
  if (!ctx.files) throw new UserFacingError("File storage is not configured for this environment.");
  return ctx.files;
};

// ---- projects ---------------------------------------------------------------------------------------------------

export async function createProject(ctx: PreconContext, raw: unknown): Promise<PreconProject> {
  const repo = manager(ctx);
  const p = await repo.createProject(parse(projectInputSchema, raw));
  await audit(ctx, { project_id: p.id, action: "project.create", entity: "project", entity_id: p.id, detail: {} });
  return p;
}

export async function updateProject(ctx: PreconContext, id: unknown, raw: unknown): Promise<PreconProject> {
  const repo = manager(ctx);
  const pid = parse(uuid, id);
  const patch = parse(projectPatchSchema, raw);
  const p = await repo.updateProject(pid, patch);
  await audit(ctx, { project_id: pid, action: "project.update", entity: "project", entity_id: pid, detail: { fields: Object.keys(patch).join(",") } });
  return p;
}

export async function archiveProject(ctx: PreconContext, id: unknown, archived: boolean): Promise<PreconProject> {
  const repo = manager(ctx);
  const pid = parse(uuid, id);
  const p = await repo.setProjectArchived(pid, archived === true);
  await audit(ctx, { project_id: pid, action: archived ? "project.archive" : "project.restore", entity: "project", entity_id: pid, detail: {} });
  return p;
}

// ---- documents --------------------------------------------------------------------------------------------------

export interface UploadTicket { documentId: string; uploadUrl: string }

/** Step 1 of an upload: validate, create the pending row, and hand back a short-lived signed upload URL. No bytes are accepted here. */
export async function beginUpload(ctx: PreconContext, raw: unknown): Promise<UploadTicket> {
  const repo = manager(ctx);
  const files = needFiles(ctx);
  const input = parse(beginUploadSchema, raw);
  const check = checkUploadMeta(input.filename, input.mime, input.size, input.kind);
  if (!check.ok) throw new UserFacingError(check.message);
  const project = await repo.getProject(input.projectId);
  if (!project) throw new UserFacingError("Project not found.");
  if (project.archived_at) throw new UserFacingError("Archived projects cannot receive uploads. Restore the project first.");

  const filename = displayFilename(input.filename);
  const id = randomUUID();
  const path = storagePath(input.projectId, id, filename);
  await repo.createDocument({
    id, project_id: input.projectId, title: input.title ?? filename.replace(/\.[A-Za-z0-9]{1,5}$/, "").slice(0, 200), filename,
    kind: input.kind, mime_type: check.mime, size_bytes: input.size, storage_path: path,
  });
  try {
    const { url } = await files.createUpload(path);
    return { documentId: id, uploadUrl: url };
  } catch (e) {
    (ctx.log ?? console.error)("[precon] signed upload failed", e);
    await repo.deleteDocument(id).catch(() => undefined); // no row without a way to upload to it
    throw new UserFacingError("The upload could not be started. Please try again.");
  }
}

/** Failures that mean the upload itself was not acceptable (as opposed to "the text could not be read"): the file and row are removed. */
const REJECT: ReadonlySet<string> = new Set(["unsupported_type", "too_large", "empty", "content_mismatch", "duplicate_content", "storage_missing"]);

export type FinishResult = { ok: true; document: PreconDocument } | { ok: false; error: string };

/** Step 2: the browser has uploaded the file; verify its real bytes, extract, chunk and index it. */
export async function finishUpload(ctx: PreconContext, raw: unknown): Promise<FinishResult> {
  const repo = manager(ctx);
  const files = needFiles(ctx);
  const { documentId, replaces } = parse(finishUploadSchema, raw);
  const doc = await repo.getDocument(documentId);
  if (!doc) throw new UserFacingError("Document not found.");
  if (doc.status !== "pending") throw new UserFacingError("This upload has already been processed.");

  const result = await ingestDocument({ repo, files, log: ctx.log }, documentId);
  if (result.status === "failed" && result.status_detail && REJECT.has(result.status_detail)) {
    const info = await repo.getDocumentStorage(documentId);
    if (info) await files.remove(info.storage_path).catch((e) => (ctx.log ?? console.error)("[precon] cleanup failed", e));
    await repo.deleteDocument(documentId);
    return { ok: false, error: DETAIL_TEXT[result.status_detail] ?? "The file could not be accepted." };
  }
  await audit(ctx, { project_id: doc.project_id, action: "document.upload", entity: "document", entity_id: documentId, detail: { filename: doc.filename, size: doc.size_bytes, status: result.status } });
  if (replaces && result.status === "processed") {
    const old = await repo.getDocument(replaces);
    if (old && old.project_id === doc.project_id && old.id !== documentId) await removeDocument(ctx, replaces);
  }
  return { ok: true, document: result };
}

export async function reprocessDocument(ctx: PreconContext, id: unknown): Promise<PreconDocument> {
  const repo = manager(ctx);
  const files = needFiles(ctx);
  const docId = parse(uuid, id);
  const doc = await repo.getDocument(docId);
  if (!doc || !doc.has_file) throw new UserFacingError("Document not found.");
  if (doc.status === "pending" || doc.status === "processing") throw new UserFacingError("This document is still being uploaded or processed.");
  const result = await ingestDocument({ repo, files, log: ctx.log }, docId);
  await audit(ctx, { project_id: doc.project_id, action: "document.reprocess", entity: "document", entity_id: docId, detail: { status: result.status } });
  return result;
}

/**
 * Removes the stored file FIRST, then the row (and with it the extracted text). Doing it in this order means a failure leaves
 * a complete, retryable document, never a row pointing at a deleted file or a stored file nobody can see (the storage read
 * policy is defined by the row, so the file cannot be removed once the row is gone).
 */
export async function removeDocument(ctx: PreconContext, id: unknown): Promise<void> {
  const repo = manager(ctx);
  const docId = parse(uuid, id);
  const doc = await repo.getDocument(docId);
  if (!doc) throw new UserFacingError("Document not found.");
  const info = await repo.getDocumentStorage(docId);
  if (info) {
    try {
      await needFiles(ctx).remove(info.storage_path);
    } catch (e) {
      (ctx.log ?? console.error)("[precon] storage removal failed", e);
      throw new UserFacingError("The file could not be removed from storage, so nothing was deleted. Please try again.");
    }
  }
  await repo.deleteDocument(docId);
  await audit(ctx, { project_id: doc.project_id, action: "document.remove", entity: "document", entity_id: docId, detail: { filename: doc.filename } });
}

/** A short-lived URL to the stored file, for anyone who may see the document (the repository applies the same visibility as the database). */
export async function documentLink(ctx: PreconContext, id: unknown, opts: { download?: boolean } = {}): Promise<string> {
  const repo = repoOf(ctx);
  const docId = parse(uuid, id);
  const info = await repo.getDocumentStorage(docId);
  if (!info) throw new UserFacingError("This document has no stored file.");
  return needFiles(ctx).signedUrl(info.storage_path, 60, opts.download ? { downloadAs: info.filename } : undefined);
}

// ---- inventory import -------------------------------------------------------------------------------------------

function cleanMapping(raw: Record<string, number> | undefined, columns: number): ColumnMapping | undefined {
  if (!raw) return undefined;
  const out: ColumnMapping = {};
  const used = new Set<number>();
  for (const [k, v] of Object.entries(raw)) {
    if (!(IMPORT_FIELDS as readonly string[]).includes(k)) throw new UserFacingError("Unknown column assignment.");
    if (v >= columns) throw new UserFacingError("A mapped column does not exist in this file.");
    if (used.has(v)) throw new UserFacingError("Each column can be used for one field only.");
    used.add(v);
    out[k as ImportField] = v;
  }
  return out;
}

async function loadImport(ctx: PreconContext, documentId: string, mapping: Record<string, number> | undefined) {
  const repo = manager(ctx);
  const files = needFiles(ctx);
  const doc = await repo.getDocument(documentId);
  const info = await repo.getDocumentStorage(documentId);
  if (!doc || !info) throw new UserFacingError("Document not found.");
  const ext = extOf(info.filename);
  if (ext !== "csv" && ext !== "xlsx") throw new UserFacingError("Only CSV and XLSX documents can be imported as inventory.");
  if (doc.status !== "processed") throw new UserFacingError("Wait until the document has been processed.");
  const bytes = await files.download(info.storage_path);
  if (!bytes) throw new UserFacingError("The stored file could not be found.");
  const content = checkContent(ext, bytes);
  if (!content.ok) throw new UserFacingError(content.message);
  let table;
  try {
    table = await readTable(ext, bytes);
  } catch (e) {
    throw new UserFacingError(e instanceof ExtractError ? e.message : "The spreadsheet could not be read.");
  }
  const columns = Math.max(0, ...table.rows.map((r) => r.length));
  const existing = await repo.inventoryForImport(info.project_id);
  const preview = previewImport({ table: table.rows, mapping: cleanMapping(mapping, columns), existing });
  return { repo, doc, info, preview };
}

export interface ImportPreviewResult { document: { id: string; title: string; filename: string; project_id: string }; preview: ImportPreview }

/** Reads and validates the spreadsheet and compares it with stored inventory. Writes nothing. */
export async function previewInventoryImport(ctx: PreconContext, documentId: unknown, mapping?: Record<string, number>): Promise<ImportPreviewResult> {
  const id = parse(uuid, documentId);
  const { doc, preview } = await loadImport(ctx, id, mapping);
  return { document: { id: doc.id, title: doc.title, filename: doc.filename, project_id: doc.project_id }, preview };
}

export interface ImportOutcome { inserted: number; updated: number; skipped_duplicates: number; skipped_conflicts: number; skipped_errors: number }

/**
 * Applies a reviewed import. The file is parsed and compared AGAIN here (nothing the browser sends is trusted as data).
 * New rows are inserted. Conflicting rows are only updated when the caller explicitly chose "update_conflicts"; duplicates and
 * rows with errors are never written. Stored values are never erased by blank cells.
 */
export async function commitInventoryImport(ctx: PreconContext, raw: unknown): Promise<ImportOutcome> {
  const input = parse(importCommitSchema, raw);
  const { repo, doc, preview } = await loadImport(ctx, input.documentId, input.mapping);
  if (preview.blocking) throw new UserFacingError(preview.blocking);
  if (preview.counts.error > 0 && !input.skipErrors) throw new UserFacingError("Some rows have errors. Fix the file, or confirm that rows with errors are skipped.");
  const meta = { source: `import: ${doc.filename}`.slice(0, 200), source_document_id: doc.id };

  const inserts: InventoryInput[] = preview.rows.filter((r) => r.status === "new" && r.data).map((r) => r.data!);
  let inserted = 0;
  for (let i = 0; i < inserts.length; i += 500) inserted += await repo.insertInventory(doc.project_id, inserts.slice(i, i + 500), meta);

  let updated = 0;
  if (input.mode === "update_conflicts") {
    for (const r of preview.rows.filter((x) => x.status === "conflict" && x.existing_id)) {
      const patch = Object.fromEntries(r.changes.map((c) => [c.field, c.to])) as Partial<InventoryInput>;
      await repo.updateInventory(r.existing_id!, patch, meta);
      updated++;
    }
  }
  const outcome: ImportOutcome = {
    inserted, updated, skipped_duplicates: preview.counts.duplicate,
    skipped_conflicts: input.mode === "update_conflicts" ? 0 : preview.counts.conflict, skipped_errors: preview.counts.error,
  };
  await audit(ctx, { project_id: doc.project_id, action: "inventory.import", entity: "inventory", entity_id: null, detail: { filename: doc.filename, mode: input.mode, ...outcome } });
  return outcome;
}

export async function verifyInventory(ctx: PreconContext, id: unknown, verified: boolean): Promise<void> {
  const repo = manager(ctx);
  const unitId = parse(uuid, id);
  await repo.verifyInventory(unitId, verified === true);
  await audit(ctx, { project_id: null, action: verified ? "inventory.verify" : "inventory.unverify", entity: "inventory", entity_id: unitId, detail: {} });
}
