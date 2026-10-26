import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { DocumentStorageInfo, FileStore, PreconRepo } from "@/lib/precon/repo";
import {
  ACTIVE_STATUSES, deriveStatus, type DocumentPage, type InventoryListItem, type InventoryUnit, type PreconDocument, type PreconProject, type SearchHit,
} from "@/lib/precon/types";
import type { Profile } from "@/lib/types";
import { UserFacingError } from "../types";

// NOT VERIFIED AGAINST A LIVE DATABASE. Every query runs as the signed-in user, so row level security from
// supabase/proposed/0007_preconstruction.proposed.sql does the filtering; this file only chooses columns. Columns are listed
// explicitly (never `*`) so storage paths and content hashes are never read into the app server's responses by accident, and
// unit_number is never requested through the table (members have no privilege on it).

export const PRECON_BUCKET = "precon-files";

const PROJECT_COLS = "id, name, developer, city, address, status, description, expected_completion, archived_at, created_at, updated_at";
const DOC_COLS =
  "id, project_id, title, filename, kind, mime_type, size_bytes, status, status_detail, page_count, chunk_count, extractor_version, attempts, uploaded_by, created_at, processed_at, uploader:profiles!precon_documents_uploaded_by_fkey(full_name)";
const UNIT_COLS =
  "id, project_id, unit_type, bedrooms, den, bathrooms, area_sqft, price, currency, availability, expected_occupancy, source, source_document_id, verified_at, updated_at";

type DocRow = Omit<PreconDocument, "uploader_name" | "has_file"> & { uploader: { full_name: string } | null };
type UnitRow = Omit<InventoryUnit, "unit_number">;

const num = (v: unknown): number | null => (v === null || v === undefined ? null : Number(v));

function check<T>(res: { data: T | null; error: { message: string; code?: string } | null }): T {
  if (res.error) {
    if (res.error.code === "42501") throw new UserFacingError("You do not have permission to do that.");
    if (res.error.code === "23505") throw new UserFacingError("That record already exists.");
    throw new Error(res.error.message);
  }
  return res.data as T;
}

const toDoc = ({ uploader, ...d }: DocRow): PreconDocument => ({
  ...d,
  size_bytes: Number(d.size_bytes),
  status: deriveStatus(d),
  uploader_name: uploader?.full_name ?? null,
  has_file: true,
});

const toUnit = (r: UnitRow, unitNumber: string | null): InventoryUnit => ({
  ...r, unit_number: unitNumber, bedrooms: num(r.bedrooms), bathrooms: num(r.bathrooms), area_sqft: num(r.area_sqft), price: num(r.price),
});

export function createSupabasePreconRepo(db: SupabaseClient, user: Profile): PreconRepo {
  const isAdmin = user.role === "admin";
  const count = async (q: PromiseLike<{ count: number | null; error: { message: string } | null }>) => {
    const { count: n, error } = await q;
    if (error) throw new Error(error.message);
    return n ?? 0;
  };
  const projectsHead = () => db.from("precon_projects").select("id", { count: "exact", head: true }).is("archived_at", null);

  async function unitNumbers(projectId?: string): Promise<Map<string, string>> {
    if (!isAdmin) return new Map();
    const rows = check(await db.rpc("precon_unit_numbers", { p_project: projectId ?? null })) as { id: string; unit_number: string }[] | null;
    return new Map((rows ?? []).map((r) => [r.id, r.unit_number]));
  }

  const repo: PreconRepo = {
    writable: true,

    async overview() {
      const [projects, active, inventory, available, documents, renderings, recent] = await Promise.all([
        count(projectsHead()),
        count(projectsHead().in("status", ACTIVE_STATUSES)),
        count(db.from("precon_inventory").select("id", { count: "exact", head: true })),
        count(db.from("precon_inventory").select("id", { count: "exact", head: true }).eq("availability", "available")),
        count(db.from("precon_documents").select("id", { count: "exact", head: true })),
        count(db.from("precon_documents").select("id", { count: "exact", head: true }).eq("kind", "rendering")),
        db.from("precon_projects").select(PROJECT_COLS).is("archived_at", null).order("updated_at", { ascending: false }).limit(5),
      ]);
      return {
        projects, active_developments: active, inventory_records: inventory, available_units: available, documents, renderings,
        recent: check(recent) as PreconProject[],
      };
    },
    async listProjects(o) {
      let q = db.from("precon_projects").select(PROJECT_COLS).order("name");
      if (!o?.includeArchived) q = q.is("archived_at", null);
      return check(await q) as PreconProject[];
    },
    async getProject(id) {
      return check(await db.from("precon_projects").select(PROJECT_COLS).eq("id", id).maybeSingle()) as PreconProject | null;
    },
    async createProject(input) {
      return check(await db.from("precon_projects").insert({ ...input, created_by: user.id }).select(PROJECT_COLS).single()) as PreconProject;
    },
    async updateProject(id, patch) {
      const row = check(await db.from("precon_projects").update(patch).eq("id", id).select(PROJECT_COLS).maybeSingle());
      if (!row) throw new UserFacingError("Project not found.");
      return row as PreconProject;
    },
    async setProjectArchived(id, archived) {
      const row = check(await db.from("precon_projects").update({ archived_at: archived ? new Date().toISOString() : null }).eq("id", id).select(PROJECT_COLS).maybeSingle());
      if (!row) throw new UserFacingError("Project not found.");
      return row as PreconProject;
    },

    async listDocuments(projectId) {
      let q = db.from("precon_documents").select(DOC_COLS).order("created_at", { ascending: false });
      if (projectId) q = q.eq("project_id", projectId);
      return (check(await q) as unknown as DocRow[]).map(toDoc);
    },
    async getDocument(id) {
      const row = check(await db.from("precon_documents").select(DOC_COLS).eq("id", id).maybeSingle());
      return row ? toDoc(row as unknown as DocRow) : null;
    },
    async getDocumentStorage(id): Promise<DocumentStorageInfo | null> {
      return check(await db.from("precon_documents").select("storage_path, project_id, filename, mime_type, size_bytes").eq("id", id).maybeSingle()) as DocumentStorageInfo | null;
    },
    async documentPages(id): Promise<DocumentPage[]> {
      const rows = check(await db.from("precon_chunks").select("page, content, chunk_index").eq("document_id", id).order("chunk_index")) as { page: number | null; content: string }[];
      const pages = new Map<number | null, string[]>();
      for (const r of rows) pages.set(r.page, [...(pages.get(r.page) ?? []), r.content]);
      return [...pages.entries()].map(([page, parts]) => ({ page, text: parts.join("\n") }));
    },
    async createDocument(n) {
      const row = check(await db.from("precon_documents").insert({ ...n, uploaded_by: user.id }).select(DOC_COLS).single());
      return toDoc(row as unknown as DocRow);
    },
    async findDocumentByHash(projectId, sha256) {
      return check(await db.from("precon_documents").select("id").eq("project_id", projectId).eq("sha256", sha256).maybeSingle()) as { id: string } | null;
    },
    async updateDocument(id, patch) {
      check(await db.from("precon_documents").update(patch).eq("id", id).select("id").single());
    },
    async replaceChunks(documentId, projectId, chunks) {
      check(await db.from("precon_chunks").delete().eq("document_id", documentId).select("id"));
      for (let i = 0; i < chunks.length; i += 200) {
        const batch = chunks.slice(i, i + 200).map((c, j) => ({ document_id: documentId, project_id: projectId, chunk_index: i + j, page: c.page, content: c.text }));
        check(await db.from("precon_chunks").insert(batch).select("id"));
      }
    },
    async deleteDocument(id) {
      check(await db.from("precon_documents").delete().eq("id", id).select("id").single());
    },
    async searchChunks(query, o): Promise<SearchHit[]> {
      const rows = check(await db.rpc("precon_search_chunks", { q: query, p_project: o?.projectId ?? null, lim: o?.limit ?? 8 })) as
        { chunk_id: string; document_id: string; project_id: string; page: number | null; content: string; rank: number }[] | null;
      return (rows ?? []).map((r) => ({ ...r, rank: Number(r.rank) }));
    },

    async listInventory(f = {}): Promise<InventoryListItem[]> {
      const projects = check(await db.from("precon_projects").select("id, name, city, developer").is("archived_at", null)) as
        { id: string; name: string; city: string | null; developer: string | null }[];
      const byId = new Map(projects.map((p) => [p.id, p]));
      // Admins also see archived projects' records through the project policy, but lists show active projects only, like the memory repo.
      let ids = projects.filter((p) => (f.city ? (p.city ?? "").toLowerCase() === f.city.toLowerCase() : true)).map((p) => p.id);
      if (f.project_id) ids = ids.filter((id) => id === f.project_id);
      if (ids.length === 0) return [];
      let q = db.from("precon_inventory").select(UNIT_COLS).in("project_id", ids);
      if (f.unit_type) q = q.ilike("unit_type", f.unit_type.replace(/[%_\\]/g, "\\$&"));
      if (f.bedrooms !== undefined) q = q.eq("bedrooms", f.bedrooms);
      if (f.availability) q = q.eq("availability", f.availability);
      if (f.min_price !== undefined) q = q.gte("price", f.min_price);
      if (f.max_price !== undefined) q = q.lte("price", f.max_price);
      const sort = f.sort ?? "price_asc";
      q = sort === "price_desc" ? q.order("price", { ascending: false, nullsFirst: false })
        : sort === "updated_desc" ? q.order("updated_at", { ascending: false })
        : sort === "area_desc" ? q.order("area_sqft", { ascending: false, nullsFirst: false })
        : q.order("price", { ascending: true, nullsFirst: false });
      const rows = check(await q.limit(f.limit ?? 500)) as unknown as UnitRow[];
      const numbers = await unitNumbers(f.project_id);
      return rows.map((r) => {
        const p = byId.get(r.project_id)!;
        return { ...toUnit(r, numbers.get(r.id) ?? null), project_name: p.name, project_city: p.city, project_developer: p.developer };
      });
    },
    async inventoryForImport(projectId) {
      if (!isAdmin) throw new UserFacingError("You do not have permission to do that.");
      const rows = check(await db.from("precon_inventory").select(UNIT_COLS).eq("project_id", projectId)) as unknown as UnitRow[];
      const numbers = await unitNumbers(projectId);
      return rows.map((r) => toUnit(r, numbers.get(r.id) ?? null));
    },
    async insertInventory(projectId, rows, meta) {
      if (rows.length === 0) return 0;
      const payload = rows.map((r) => ({ ...r, project_id: projectId, source: meta.source, source_document_id: meta.source_document_id, created_by: user.id }));
      for (let i = 0; i < payload.length; i += 200) check(await db.from("precon_inventory").insert(payload.slice(i, i + 200)).select("id"));
      return rows.length;
    },
    async updateInventory(id, patch, meta) {
      // unit_number is not updatable (column privilege), so it is never sent.
      const { unit_number: _ignored, ...fields } = patch;
      void _ignored;
      check(await db.from("precon_inventory").update({ ...fields, source: meta.source, source_document_id: meta.source_document_id, verified_at: null }).eq("id", id).select("id").single());
    },
    async verifyInventory(id, verified) {
      check(await db.from("precon_inventory").update({ verified_at: verified ? new Date().toISOString() : null }).eq("id", id).select("id").single());
    },

    async recordAudit(e) {
      check(await db.from("precon_audit").insert({ ...e, actor_id: user.id }).select("id"));
    },
  };
  return repo;
}

/** Private bucket access as the signed-in user: the storage policies in 0007 decide who may read, upload and delete. */
export function createSupabaseFileStore(db: SupabaseClient): FileStore {
  const bucket = () => db.storage.from(PRECON_BUCKET);
  return {
    async createUpload(path) {
      const { data, error } = await bucket().createSignedUploadUrl(path);
      if (error || !data) throw new Error(error?.message ?? "no upload url");
      return { url: data.signedUrl, token: data.token };
    },
    async download(path) {
      const { data, error } = await bucket().download(path);
      if (error || !data) {
        if (/not.?found|does not exist/i.test(error?.message ?? "")) return null;
        throw new Error(error?.message ?? "download failed");
      }
      return new Uint8Array(await data.arrayBuffer());
    },
    async remove(path) {
      const { error } = await bucket().remove([path]);
      if (error) throw new Error(error.message);
    },
    async signedUrl(path, expiresInSeconds, o) {
      const { data, error } = await bucket().createSignedUrl(path, expiresInSeconds, o?.downloadAs ? { download: o.downloadAs } : undefined);
      if (error || !data) throw new Error(error?.message ?? "no signed url");
      return data.signedUrl;
    },
  };
}
