import { randomUUID } from "node:crypto";
import { UserFacingError } from "@/lib/backend/types";
import type { Profile } from "@/lib/types";
import type { DocumentPatch, DocumentStorageInfo, PreconRepo } from "./repo";
import { parseQuery, scoreText } from "./search";
import {
  ACTIVE_STATUSES, deriveStatus, type AuditEntry, type DocumentPage, type InventoryFilter, type InventoryInput, type InventoryListItem, type InventoryUnit,
  type NewDocument, type PreconDocument, type PreconProject, type ProjectInput, type SearchHit, type TextChunk,
} from "./types";

/**
 * In-memory implementation of PreconRepo. It backs the read-only demo (synthetic data) and the tests. It enforces the same
 * rules as the database policies in supabase/proposed/0007, independently of the pages and actions: members never write, members
 * never see archived projects, and only administrators see unit numbers. Nothing here touches a network or the filesystem.
 */

export interface StoredDocument extends PreconDocument {
  storage_path: string | null;
  sha256: string | null;
}
export interface StoredChunk { id: string; document_id: string; project_id: string; chunk_index: number; page: number | null; content: string }
/** unit_number is present here; it is stripped per user on read. */
export type StoredUnit = InventoryUnit;

export interface MemoryStore {
  projects: PreconProject[];
  documents: StoredDocument[];
  chunks: StoredChunk[];
  inventory: StoredUnit[];
  audit: (AuditEntry & { actor_id: string; at: string })[];
}

export const emptyStore = (): MemoryStore => ({ projects: [], documents: [], chunks: [], inventory: [], audit: [] });

const DENIED = "You do not have permission to do that.";
const READ_ONLY = "The demo is read-only: Pre-Construction records cannot be changed here.";

export function createMemoryPreconRepo(opts: { user: Profile; store: MemoryStore; writable: boolean; now?: () => Date }): PreconRepo {
  const { user, store } = opts;
  const now = () => (opts.now ?? (() => new Date()))().toISOString();
  const isAdmin = user.role === "admin";

  const visible = (p: PreconProject) => isAdmin || p.archived_at === null;
  const visibleIds = () => new Set(store.projects.filter(visible).map((p) => p.id));
  const project = (id: string) => store.projects.find((p) => p.id === id && visible(p)) ?? null;
  const admin = () => {
    if (!opts.writable) throw new UserFacingError(READ_ONLY);
    if (!isAdmin) throw new UserFacingError(DENIED);
  };
  const publicDoc = (stored: StoredDocument): PreconDocument => {
    const { storage_path, sha256: _hash, ...d } = stored;
    void _hash;
    return { ...d, status: deriveStatus(d), has_file: storage_path !== null };
  };
  const publicUnit = (u: StoredUnit): InventoryUnit => ({ ...u, unit_number: isAdmin ? u.unit_number : null });
  const doc = (id: string) => {
    const d = store.documents.find((x) => x.id === id);
    return d && project(d.project_id) ? d : null;
  };

  return {
    writable: opts.writable,

    async overview() {
      const projects = store.projects.filter(visible);
      const ids = new Set(projects.map((p) => p.id));
      const docs = store.documents.filter((d) => ids.has(d.project_id));
      const units = store.inventory.filter((u) => ids.has(u.project_id));
      return {
        projects: projects.length,
        active_developments: projects.filter((p) => !p.archived_at && ACTIVE_STATUSES.includes(p.status)).length,
        inventory_records: units.length,
        available_units: units.filter((u) => u.availability === "available").length,
        documents: docs.length,
        renderings: docs.filter((d) => d.kind === "rendering").length,
        recent: [...projects].sort((a, b) => b.updated_at.localeCompare(a.updated_at)).slice(0, 5),
      };
    },
    async listProjects(o) {
      return store.projects.filter((p) => visible(p) && (o?.includeArchived ? true : p.archived_at === null)).sort((a, b) => a.name.localeCompare(b.name));
    },
    async getProject(id) { return project(id); },
    async createProject(input: ProjectInput) {
      admin();
      const t = now();
      const p: PreconProject = { id: randomUUID(), ...input, archived_at: null, created_at: t, updated_at: t };
      store.projects.push(p);
      return p;
    },
    async updateProject(id, patch) {
      admin();
      const p = project(id);
      if (!p) throw new UserFacingError("Project not found.");
      Object.assign(p, patch, { updated_at: now() });
      return p;
    },
    async setProjectArchived(id, archived) {
      admin();
      const p = project(id);
      if (!p) throw new UserFacingError("Project not found.");
      p.archived_at = archived ? now() : null;
      p.updated_at = now();
      return p;
    },

    async listDocuments(projectId) {
      return store.documents.filter((d) => project(d.project_id) && (!projectId || d.project_id === projectId)).sort((a, b) => b.created_at.localeCompare(a.created_at)).map(publicDoc);
    },
    async getDocument(id) { const d = doc(id); return d ? publicDoc(d) : null; },
    async getDocumentStorage(id): Promise<DocumentStorageInfo | null> {
      const d = doc(id);
      return d && d.storage_path ? { storage_path: d.storage_path, project_id: d.project_id, filename: d.filename, mime_type: d.mime_type, size_bytes: d.size_bytes } : null;
    },
    async documentPages(id): Promise<DocumentPage[]> {
      if (!doc(id)) return [];
      const pages = new Map<number | null, string[]>();
      for (const c of store.chunks.filter((x) => x.document_id === id).sort((a, b) => a.chunk_index - b.chunk_index)) pages.set(c.page, [...(pages.get(c.page) ?? []), c.content]);
      return [...pages.entries()].map(([page, parts]) => ({ page, text: parts.join("\n") }));
    },
    async createDocument(n: NewDocument) {
      admin();
      if (!project(n.project_id)) throw new UserFacingError("Project not found.");
      const d: StoredDocument = {
        ...n, status: "pending", status_detail: null, page_count: null, chunk_count: 0, extractor_version: null, attempts: 0, uploaded_by: user.id,
        uploader_name: user.full_name, created_at: now(), processed_at: null, has_file: true, sha256: null,
      };
      store.documents.push(d);
      return publicDoc(d);
    },
    async findDocumentByHash(projectId, sha256) {
      const d = store.documents.find((x) => x.project_id === projectId && x.sha256 === sha256);
      return d && project(d.project_id) ? { id: d.id } : null;
    },
    async updateDocument(id, patch: DocumentPatch) {
      admin();
      const d = doc(id);
      if (!d) throw new UserFacingError("Document not found.");
      Object.assign(d, patch);
    },
    async replaceChunks(documentId, projectId, chunks: TextChunk[]) {
      admin();
      const d = doc(documentId);
      if (!d || d.project_id !== projectId) throw new UserFacingError("Document not found.");
      store.chunks = store.chunks.filter((c) => c.document_id !== documentId);
      chunks.forEach((c, i) => store.chunks.push({ id: randomUUID(), document_id: documentId, project_id: projectId, chunk_index: i, page: c.page, content: c.text }));
    },
    async deleteDocument(id) {
      admin();
      if (!doc(id)) throw new UserFacingError("Document not found.");
      store.documents = store.documents.filter((d) => d.id !== id);
      store.chunks = store.chunks.filter((c) => c.document_id !== id);
      for (const u of store.inventory) if (u.source_document_id === id) u.source_document_id = null;
    },
    async searchChunks(query, o): Promise<SearchHit[]> {
      const groups = parseQuery(query);
      const ids = visibleIds();
      const hits: SearchHit[] = [];
      for (const c of store.chunks) {
        if (!ids.has(c.project_id) || (o?.projectId && c.project_id !== o.projectId)) continue;
        const rank = scoreText(c.content, groups);
        if (rank > 0) hits.push({ chunk_id: c.id, document_id: c.document_id, project_id: c.project_id, page: c.page, content: c.content, rank });
      }
      return hits.sort((a, b) => b.rank - a.rank || a.document_id.localeCompare(b.document_id)).slice(0, Math.min(Math.max(o?.limit ?? 8, 1), 20));
    },

    async listInventory(f: InventoryFilter = {}): Promise<InventoryListItem[]> {
      // Lists and the AI Brain cover active projects only (archived ones are reachable by an administrator through the project page).
      const byId = new Map(store.projects.filter((p) => visible(p) && p.archived_at === null).map((p) => [p.id, p]));
      let rows = store.inventory.filter((u) => byId.has(u.project_id));
      if (f.project_id) rows = rows.filter((u) => u.project_id === f.project_id);
      if (f.city) rows = rows.filter((u) => (byId.get(u.project_id)!.city ?? "").toLowerCase() === f.city!.toLowerCase());
      if (f.unit_type) rows = rows.filter((u) => (u.unit_type ?? "").toLowerCase() === f.unit_type!.toLowerCase());
      if (f.bedrooms !== undefined) rows = rows.filter((u) => u.bedrooms === f.bedrooms);
      if (f.availability) rows = rows.filter((u) => u.availability === f.availability);
      // A record without a price never satisfies a price filter (it is not "cheap", it is unknown).
      if (f.min_price !== undefined) rows = rows.filter((u) => u.price !== null && u.price >= f.min_price!);
      if (f.max_price !== undefined) rows = rows.filter((u) => u.price !== null && u.price <= f.max_price!);
      const sort = f.sort ?? "price_asc";
      const priceCmp = (a: StoredUnit, b: StoredUnit, dir: 1 | -1) => (a.price === null ? 1 : b.price === null ? -1 : (a.price - b.price) * dir);
      rows = [...rows].sort((a, b) =>
        sort === "price_desc" ? priceCmp(a, b, -1) : sort === "updated_desc" ? b.updated_at.localeCompare(a.updated_at) :
        sort === "area_desc" ? (b.area_sqft ?? -1) - (a.area_sqft ?? -1) : priceCmp(a, b, 1));
      return rows.slice(0, f.limit ?? 500).map((u) => {
        const p = byId.get(u.project_id)!;
        return { ...publicUnit(u), project_name: p.name, project_city: p.city, project_developer: p.developer };
      });
    },
    async inventoryForImport(projectId) {
      admin();
      return store.inventory.filter((u) => u.project_id === projectId && project(u.project_id)).map(publicUnit);
    },
    async insertInventory(projectId, rows: InventoryInput[], meta) {
      admin();
      if (!project(projectId)) throw new UserFacingError("Project not found.");
      const taken = new Set(store.inventory.filter((u) => u.project_id === projectId && u.unit_number).map((u) => u.unit_number!.toLowerCase()));
      for (const r of rows) if (r.unit_number && taken.has(r.unit_number.toLowerCase())) throw new UserFacingError(`Unit ${r.unit_number} already exists in this project.`);
      const t = now();
      for (const r of rows) store.inventory.push({ id: randomUUID(), project_id: projectId, ...r, source: meta.source, source_document_id: meta.source_document_id, verified_at: null, updated_at: t });
      return rows.length;
    },
    async updateInventory(id, patch, meta) {
      admin();
      const u = store.inventory.find((x) => x.id === id && project(x.project_id));
      if (!u) throw new UserFacingError("Inventory record not found.");
      Object.assign(u, patch, { source: meta.source, source_document_id: meta.source_document_id, verified_at: null, updated_at: now() });
    },
    async verifyInventory(id, verified) {
      admin();
      const u = store.inventory.find((x) => x.id === id && project(x.project_id));
      if (!u) throw new UserFacingError("Inventory record not found.");
      u.verified_at = verified ? now() : null;
    },

    async recordAudit(entry) {
      admin();
      store.audit.push({ ...entry, actor_id: user.id, at: now() });
    },
  };
}
