import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import { hashContent, normalizeText, stableEntityId, stableRelationshipId } from "@/lib/ai-brain/org-memory/memory-repo";
import type {
  DocChange, DocInput, EntityFields, EntityQuery, FailureCode, OrgEntity, OrgMemoryAccess, OrgRelationshipView, RelationshipFields, RelationshipQuery, ReviewAction, ReviewEvent, SourceDoc,
  UpsertEntitiesResult, UpsertRelationshipsResult,
} from "@/lib/ai-brain/org-memory/types";
import { isEligibleEndpoint } from "@/lib/ai-brain/org-memory/relationships";
import { cannotImprove, ENDPOINT_BATCH, MAX_ENDPOINT_IDS, MAX_SEARCH_PAGES, mergeTop, rankByHits, SEARCH_PAGE_SIZE, searchWords } from "@/lib/ai-brain/org-memory/query";
import type { Profile } from "@/lib/types";
import { UserFacingError } from "../types";

// STATUS: written against supabase/proposed/0013_org_memory.proposed.sql, which is PROPOSED and NOT APPLIED to any project. This adapter has therefore never
// run against a real database; only the SQL (local PGlite, supabase/proposed/tests/0013_org_memory.pglite.mjs) and a stub contract test
// (tests/org-memory-supabase-contract.test.ts) have been exercised.
// Every call runs as the SIGNED-IN USER (their session, never the service role). Row level security limits reads to administrators; writes exist only as
// SECURITY DEFINER functions that check is_admin() against the caller's session. A non-administrator is also refused here before any call (fail closed).
// Columns are listed explicitly (never `*`). Errors never carry source text: an unrecognised database error becomes a generic Error with its code only.

const DOC_COLS = "id, provider, workspace_id, source_id, url, title, doc_type, content, segments, coverage, content_hash, last_edited, ingested_at, owner, access_scope, sync_status, attempts, last_error, extracted_hash, extraction_error, archived";
const DOC_LIGHT = "id, provider, workspace_id, source_id, title, url, content_hash, extracted_hash, sync_status, attempts, archived";
const ENTITY_COLS = "id, stable_id, source_doc_id, entity_type, name, description, evidence, basis, confidence, owner, team, due, unknowns, extracted_at, review_status, stale, pending_revision, knowledge_item_id";
const REL_COLS = "id, stable_id, source_doc_id, from_entity_id, to_entity_id, relation_type, evidence, basis, confidence, extracted_at, review_status, stale, pending_revision";
const END = "id, entity_type, name, review_status, stale, pending_revision, source_doc_id";
/** Exported only so the read-only live smoke test probes exactly the embedded select the adapter sends. */
export const REL_SELECT = `${REL_COLS}, doc:org_source_docs!inner(archived), from:org_entities!org_relationships_from_entity_id_fkey(${END}), to:org_entities!org_relationships_to_entity_id_fkey(${END})`;
const MAX_ROWS = 200;
const MAX_UNEXTRACTED = 50;

type DocRow = Omit<SourceDoc, "last_edited" | "ingested_at"> & { last_edited: string | null; ingested_at: string };
type EntityRow = Omit<OrgEntity, "history" | "pending_revision" | "extracted_at"> & { extracted_at: string; pending_revision: (Partial<EntityFields> & { extracted_at?: string }) | null };

const iso = (s: string | null): string | null => { if (!s) return null; const t = new Date(s).getTime(); return Number.isFinite(t) ? new Date(t).toISOString() : null; };
const toDoc = (r: DocRow): SourceDoc => ({ ...r, last_edited: iso(r.last_edited), ingested_at: iso(r.ingested_at) ?? r.ingested_at });
const toEntity = (r: EntityRow, history: ReviewEvent[] = []): OrgEntity => {
  const { pending_revision: p, ...rest } = r;
  return {
    ...rest, extracted_at: iso(r.extracted_at) ?? r.extracted_at, history,
    pending_revision: p ? { entity_type: r.entity_type, name: r.name, description: p.description ?? r.description, evidence: p.evidence ?? r.evidence, basis: p.basis ?? r.basis, confidence: p.confidence ?? r.confidence,
      owner: p.owner ?? null, team: p.team ?? null, due: p.due ?? null, unknowns: p.unknowns ?? [], extracted_at: iso(p.extracted_at ?? null) ?? r.extracted_at } : null,
  };
};

type EndRow = { id: string; entity_type: OrgRelationshipView["from"]["entity_type"]; name: string; review_status: string; stale: boolean; pending_revision: unknown };
type RelRow = Omit<OrgRelationshipView, "history" | "from" | "to" | "extracted_at" | "pending_revision"> & { extracted_at: string; pending_revision: (Partial<RelationshipFields> & { extracted_at?: string }) | null; doc: unknown; from: EndRow | null; to: EndRow | null };
// The cast is needed only because the endpoint row comes back as untyped JSON; isEligibleEndpoint reads three fields of it.
const endEligible = (e: EndRow | null): boolean => Boolean(e) && isEligibleEndpoint({ review_status: e!.review_status as never, stale: e!.stale, pending_revision: e!.pending_revision as never });
const toRel = (r: RelRow, history: ReviewEvent[] = []): OrgRelationshipView => {
  const { doc: _d, from, to, pending_revision: p, ...rest } = r;
  void _d;
  return {
    ...rest, extracted_at: iso(r.extracted_at) ?? r.extracted_at, history,
    pending_revision: p ? { evidence: p.evidence ?? r.evidence, basis: p.basis ?? r.basis, confidence: p.confidence ?? r.confidence, extracted_at: iso(p.extracted_at ?? null) ?? r.extracted_at } : null,
    from: { id: from?.id ?? r.from_entity_id, entity_type: from?.entity_type ?? "task", name: from?.name ?? "" },
    to: { id: to?.id ?? r.to_entity_id, entity_type: to?.entity_type ?? "task", name: to?.name ?? "" },
  };
};

class Busy extends Error {}

/** Maps database errors to fixed outcomes. Nothing the database says about a row (which can echo source text) is passed on. */
function check<T>(res: { data: T | null; error: { message: string; code?: string } | null }): T {
  const e = res.error;
  if (e) {
    switch (e.code) {
      case "42501": throw new UserFacingError("You do not have permission to do that.");
      case "55P03": throw new Busy("an ingestion run is already in progress");
      case "55000": throw new UserFacingError("That record is not in a state where this can be done. Reload and try again.");
      case "22023": throw new UserFacingError("That value is not allowed.");
      case "P0002": throw new UserFacingError("That record was not found.");
      default: throw new Error(`organizational memory: database error ${e.code ?? "unknown"}`);
    }
  }
  return res.data as T;
}

const DENIED = new UserFacingError("You do not have permission to do that.");

export function createSupabaseOrgMemory(db: SupabaseClient, user: Profile): OrgMemoryAccess {
  const isAdmin = user.role === "admin";
  const docs = () => db.from("org_source_docs");
  const ents = () => db.from("org_entities");

  async function docByKey(provider: string, ws: string, source: string): Promise<SourceDoc | null> {
    if (!isAdmin) return null;
    const row = check(await docs().select(DOC_COLS).eq("provider", provider).eq("workspace_id", ws).eq("source_id", source).maybeSingle()) as unknown as DocRow | null;
    return row ? toDoc(row) : null;
  }
  async function history(id: string): Promise<ReviewEvent[]> {
    const rows = check(await db.from("org_entity_events").select("created_at, actor_id, action, note").eq("entity_id", id).order("created_at", { ascending: true })) as unknown as { created_at: string; actor_id: string | null; action: string; note: string | null }[] | null;
    return (rows ?? []).filter((r) => ["approve", "reject", "accept_revision", "dismiss_revision"].includes(r.action)).map((r) => ({ at: iso(r.created_at) ?? r.created_at, by: r.actor_id ?? "", action: r.action as ReviewAction, note: r.note }));
  }
  /** Review history for several records in few requests (chunked so the URL stays short). Lists must carry the same history a single read does. */
  async function histories(table: "org_entity_events" | "org_relationship_events", col: "entity_id" | "relationship_id", ids: string[]): Promise<Map<string, ReviewEvent[]>> {
    const out = new Map<string, ReviewEvent[]>();
    for (let i = 0; i < ids.length; i += 40) {
      const rows = check(await db.from(table).select(`${col}, created_at, actor_id, action, note`).in(col, ids.slice(i, i + 40)).order("created_at", { ascending: true })) as unknown as ({ created_at: string; actor_id: string | null; action: string; note: string | null } & Record<string, string | null>)[] | null;
      for (const r of rows ?? []) {
        if (!["approve", "reject", "accept_revision", "dismiss_revision"].includes(r.action)) continue;
        const key = String(r[col]);
        out.set(key, [...(out.get(key) ?? []), { at: iso(r.created_at) ?? r.created_at, by: r.actor_id ?? "", action: r.action as ReviewAction, note: r.note }]);
      }
    }
    return out;
  }
  async function entity(id: string): Promise<OrgEntity | null> {
    if (!isAdmin) return null;
    const row = check(await ents().select(`${ENTITY_COLS}, doc:org_source_docs!inner(archived)`).eq("id", id).eq("doc.archived", false).maybeSingle()) as unknown as (EntityRow & { doc: unknown }) | null;
    if (!row) return null;
    const { doc: _doc, ...clean } = row;
    void _doc;
    return toEntity(clean, await history(id));
  }

  async function relHistory(id: string): Promise<ReviewEvent[]> {
    const rows = check(await db.from("org_relationship_events").select("created_at, actor_id, action, note").eq("relationship_id", id).order("created_at", { ascending: true })) as unknown as { created_at: string; actor_id: string | null; action: string; note: string | null }[] | null;
    return (rows ?? []).filter((r) => ["approve", "reject", "accept_revision", "dismiss_revision"].includes(r.action)).map((r) => ({ at: iso(r.created_at) ?? r.created_at, by: r.actor_id ?? "", action: r.action as ReviewAction, note: r.note }));
  }
  async function relationship(id: string): Promise<OrgRelationshipView | null> {
    if (!isAdmin) return null;
    const row = check(await db.from("org_relationships").select(REL_SELECT).eq("id", id).eq("doc.archived", false).maybeSingle()) as unknown as RelRow | null;
    return row ? toRel(row, await relHistory(id)) : null;
  }

  const reader: OrgMemoryAccess["reader"] = {
    async findRelationships(q: RelationshipQuery) {
      if (!isAdmin) return [];
      const limit = Math.min(q.limit, MAX_ROWS);
      const words = searchWords(q.query); // word by word, not one whole-phrase substring (the K1/K2 defect)
      let reached = false;
      let ids: string[] | null = q.entity_id ? [q.entity_id] : null;
      if (words.length) {
        // Endpoint names that match, in stable id order, page by page up to a fixed budget (never one unordered first-200 slice).
        const found: string[] = [];
        const pages = Math.ceil(MAX_ENDPOINT_IDS / SEARCH_PAGE_SIZE);
        for (let p = 0; p < pages; p++) {
          const hits = (check(await ents().select("id").or(words.map((w) => `name.ilike."%${w}%"`).join(",")).order("id", { ascending: true })
            .range(p * SEARCH_PAGE_SIZE, (p + 1) * SEARCH_PAGE_SIZE - 1)) ?? []) as unknown as { id: string }[];
          for (const h of hits) found.push(h.id);
          if (hits.length < SEARCH_PAGE_SIZE) break;
          if (p === pages - 1) reached = true; // the last page was full: more endpoints may exist
        }
        ids = ids ? ids.filter((i) => found.includes(i)) : found;
      }
      if (ids && ids.length === 0) { if (reached && q.outcome) q.outcome.budget_reached = true; return []; }
      // The endpoint ids go to the database in small batches (a long id list in one URL would fail or be cut); a relationship that matches through both
      // ends, or in two batches, is kept once. Every batch carries the same filters and the same stable order.
      const batches: (string[] | null)[] = ids ? Array.from({ length: Math.ceil(ids.length / ENDPOINT_BATCH) }, (_v, i) => ids!.slice(i * ENDPOINT_BATCH, (i + 1) * ENDPOINT_BATCH)) : [null];
      const seen = new Map<string, RelRow>();
      let anyFull = false;
      for (const batch of batches) {
        let b = db.from("org_relationships").select(REL_SELECT).eq("doc.archived", false);
        if (q.relation_type) b = b.eq("relation_type", q.relation_type);
        if (q.source_doc_id) b = b.eq("source_doc_id", q.source_doc_id);
        if (!q.include_rejected) b = b.neq("review_status", "rejected");
        if (batch) { const list = batch.join(","); b = b.or(`from_entity_id.in.(${list}),to_entity_id.in.(${list})`); }
        const rows = (check(await b.order("extracted_at", { ascending: false }).order("id", { ascending: true }).limit(MAX_ROWS)) ?? []) as unknown as RelRow[];
        if (rows.length >= MAX_ROWS) anyFull = true;
        for (const r of rows) if (!seen.has(r.id)) seen.set(r.id, r);
      }
      const newestFirst = (x: RelRow, y: RelRow) => (x.extracted_at < y.extracted_at ? 1 : x.extracted_at > y.extracted_at ? -1 : x.id < y.id ? -1 : x.id > y.id ? 1 : 0);
      const eligible = [...seen.values()].sort(newestFirst).filter((r) => q.include_rejected || (endEligible(r.from) && endEligible(r.to)));
      // more matched words in the endpoint names first (a stable sort: equal scores stay newest first), then the caller's limit
      const kept = rankByHits(eligible, words, (r) => `${r.from?.name ?? ""} ${r.to?.name ?? ""}`).slice(0, limit);
      // A full batch means more rows may exist beyond what was read: that matters when ranking needs them or when fewer than the limit were found.
      if ((reached || (anyFull && (words.length > 1 || eligible.length < limit))) && q.outcome) q.outcome.budget_reached = true;
      const h = await histories("org_relationship_events", "relationship_id", kept.map((r) => r.id));
      return kept.map((r) => toRel(r, h.get(r.id) ?? []));
    },
    getRelationship: relationship,
    async listRelationshipQueue(limit) {
      if (!isAdmin) return [];
      const rows = check(await db.from("org_relationships").select(REL_SELECT).eq("doc.archived", false)
        .or("review_status.eq.proposed,and(stale.eq.true,pending_revision.not.is.null,review_status.neq.rejected)").neq("review_status", "rejected").order("extracted_at", { ascending: true }).limit(MAX_ROWS)) as unknown as RelRow[] | null;
      const kept = (rows ?? []).filter((r) => endEligible(r.from) && endEligible(r.to)).slice(0, Math.min(limit, MAX_ROWS));
      const h = await histories("org_relationship_events", "relationship_id", kept.map((r) => r.id));
      return kept.map((r) => toRel(r, h.get(r.id) ?? []));
    },
    async reviewRelationship(id, action, note) {
      if (!isAdmin) throw DENIED;
      if (action === "approve") {
        // Defence in depth until the database refuses this itself (see docs/PHASE2B_0014_PROPOSED_CHANGES.md): a stale link is not approved while its revision is unresolved.
        const cur = await relationship(id);
        if (cur?.stale) throw new UserFacingError("That relationship is out of date with its source. Resolve the pending revision or re-run the update first.");
      }
      check(await db.rpc("org_relationship_review", { p_id: id, p_action: action, p_note: note }));
      const r = await relationship(id);
      if (!r) throw new UserFacingError("That record was not found.");
      return r;
    },
    async findEntities(q: EntityQuery) {
      if (!isAdmin) return [];
      const limit = Math.min(q.limit, MAX_ROWS);
      // Word by word (an OR over the words), ranked by how many occur; the whole phrase only when no word survives.
      const words = searchWords(q.query);
      const page = () => {
        let b = ents().select(`${ENTITY_COLS}, doc:org_source_docs!inner(archived)`).eq("doc.archived", false);
        if (q.entity_type) b = b.eq("entity_type", q.entity_type);
        if (q.source_doc_id) b = b.eq("source_doc_id", q.source_doc_id);
        if (!q.include_rejected) b = b.neq("review_status", "rejected");
        if (words.length) b = b.or(words.flatMap((w) => ["name", "description", "owner", "team"].map((c) => `${c}.ilike."%${w}%"`)).join(","));
        return b.order("extracted_at", { ascending: false }).order("id", { ascending: true }); // a total order: pages never overlap or skip
      };
      const strip = (rows: unknown): EntityRow[] => ((rows ?? []) as (EntityRow & { doc: unknown })[]).map(({ doc: _d, ...r }) => { void _d; return r; });
      const text = (r: EntityRow) => `${r.name} ${r.description} ${r.owner ?? ""} ${r.team ?? ""}`;
      let kept: EntityRow[];
      if (words.length < 2) {
        kept = strip(check(await page().limit(limit))); // every row matches the one word: the newest `limit` are exactly the answer
      } else {
        // Ranking needs more than the newest rows: read stable pages, keep only the best `limit` so far, stop when nothing later can win or the budget ends.
        kept = [];
        for (let p = 0; p < MAX_SEARCH_PAGES; p++) {
          const rows = check(await page().range(p * SEARCH_PAGE_SIZE, (p + 1) * SEARCH_PAGE_SIZE - 1)) as unknown as unknown[] | null;
          kept = mergeTop(kept, strip(rows), words, text, limit);
          if ((rows ?? []).length < SEARCH_PAGE_SIZE || cannotImprove(kept, words, text, limit)) break;
          if (p === MAX_SEARCH_PAGES - 1 && q.outcome) q.outcome.budget_reached = true; // the last page was full: older rows were not read
        }
      }
      const h = await histories("org_entity_events", "entity_id", kept.map((r) => r.id));
      return kept.map((r) => toEntity(r, h.get(r.id) ?? []));
    },
    getEntity: entity,
    async getDocument(id) {
      if (!isAdmin) return null;
      const row = check(await docs().select(DOC_COLS).eq("id", id).eq("archived", false).maybeSingle()) as unknown as DocRow | null;
      return row ? toDoc(row) : null;
    },
    async listReviewQueue(limit) {
      if (!isAdmin) return [];
      const rows = check(await ents().select(`${ENTITY_COLS}, doc:org_source_docs!inner(archived)`).eq("doc.archived", false)
        .or("review_status.eq.proposed,and(stale.eq.true,pending_revision.not.is.null,review_status.neq.rejected)").order("extracted_at", { ascending: true }).limit(Math.min(limit, MAX_ROWS))) as unknown as (EntityRow & { doc: unknown })[] | null;
      const kept = (rows ?? []).map(({ doc: _d, ...r }) => { void _d; return r; });
      const h = await histories("org_entity_events", "entity_id", kept.map((r) => r.id));
      return kept.map((r) => toEntity(r, h.get(r.id) ?? []));
    },
    async review(id, action, note) {
      if (!isAdmin) throw DENIED;
      check(await db.rpc("org_memory_review", { p_id: id, p_action: action, p_note: note }));
      const e = await entity(id);
      if (!e) throw new UserFacingError("That record was not found.");
      return e;
    },
    async markPromotionProposed(id, knowledgeItemId) {
      if (!isAdmin) throw DENIED;
      check(await db.rpc("org_memory_mark_promotion", { p_id: id, p_knowledge: knowledgeItemId }));
      const e = await entity(id);
      if (!e) throw new UserFacingError("That record was not found.");
      return e;
    },
  };

  const writer: OrgMemoryAccess["writer"] = {
    getDoc: docByKey,
    async upsertDoc(input: DocInput) {
      if (!isAdmin) throw DENIED;
      const segments = input.segments.map((s) => ({ ...s, text: normalizeText(s.text) })).filter((s) => s.text);
      const change = check(await db.rpc("org_memory_upsert_doc", {
        p_provider: input.provider, p_workspace: input.workspace_id, p_source: input.source_id, p_url: input.url, p_title: input.title, p_type: input.doc_type,
        p_content: segments.map((s) => s.text).join("\n"), p_segments: segments, p_coverage: input.coverage, p_hash: hashContent(input.title, segments.map((s) => s.text)),
        p_last_edited: input.last_edited, p_owner: input.owner,
      })) as unknown as DocChange;
      const doc = await docByKey(input.provider, input.workspace_id, input.source_id);
      if (!doc) throw new Error("organizational memory: stored document not found after write");
      return { doc, change };
    },
    async recordFailure(provider, ws, source, meta, code: FailureCode) {
      if (!isAdmin) throw DENIED;
      check(await db.rpc("org_memory_record_failure", { p_provider: provider, p_workspace: ws, p_source: source, p_title: meta.title, p_url: meta.url, p_code: code }));
      const doc = await docByKey(provider, ws, source);
      if (!doc) throw new Error("organizational memory: stored document not found after write");
      return doc;
    },
    async listActiveSourceIds(provider, ws) {
      if (!isAdmin) return [];
      const rows = check(await docs().select("source_id").eq("provider", provider).eq("workspace_id", ws).eq("archived", false).limit(5000)) as unknown as { source_id: string }[] | null;
      return (rows ?? []).map((r) => r.source_id);
    },
    async archiveDoc(provider, ws, source) {
      if (!isAdmin) throw DENIED;
      check(await db.rpc("org_memory_archive_doc", { p_provider: provider, p_workspace: ws, p_source: source }));
    },
    async listRetryable(provider, ws, maxAttempts) {
      if (!isAdmin) return [];
      const rows = check(await docs().select(DOC_COLS).eq("provider", provider).eq("workspace_id", ws).eq("sync_status", "failed").eq("archived", false).lt("attempts", maxAttempts).limit(MAX_ROWS)) as unknown as DocRow[] | null;
      return (rows ?? []).map(toDoc);
    },
    async listUnextracted(provider, ws) {
      if (!isAdmin) return [];
      // PostgREST cannot compare two columns, so the light columns are filtered here and only the documents that need work are read in full.
      const light = check(await docs().select(DOC_LIGHT).eq("provider", provider).eq("workspace_id", ws).eq("archived", false).eq("sync_status", "synced").neq("content_hash", "").limit(5000)) as unknown as { id: string; content_hash: string; extracted_hash: string | null }[] | null;
      const ids = (light ?? []).filter((d) => d.extracted_hash !== d.content_hash).slice(0, MAX_UNEXTRACTED).map((d) => d.id);
      if (ids.length === 0) return [];
      const rows = check(await docs().select(DOC_COLS).in("id", ids)) as unknown as DocRow[] | null;
      return (rows ?? []).map(toDoc);
    },
    async upsertEntities(docId, entities, _at, opts): Promise<UpsertEntitiesResult> {
      void _at; // the database stamps extracted_at itself
      if (!isAdmin) throw DENIED;
      const out: UpsertEntitiesResult = { created: 0, updated: 0, staled: 0, unchanged: 0 };
      const keep: string[] = [];
      for (const e of entities ?? []) { // a missing list is an empty list: it keeps nothing and therefore stales nothing
        const stable = stableEntityId(docId, e.entity_type, e.name);
        if (keep.includes(stable)) continue;
        keep.push(stable);
        const r = check(await db.rpc("org_memory_upsert_entity", {
          p_doc: docId, p_stable: stable, p_type: e.entity_type, p_name: e.name, p_description: e.description, p_evidence: e.evidence, p_basis: e.basis, p_confidence: e.confidence,
          p_owner: e.owner, p_team: e.team, p_due: e.due, p_unknowns: e.unknowns,
        })) as unknown as keyof UpsertEntitiesResult;
        if (r in out) out[r] += 1;
      }
      // A partial read of the document (truncated input) proves nothing about what it no longer states, and neither does an extraction that kept
      // no valid entity at all (empty answer or everything failed validation): the database function would stale EVERY record, reviewed ones included.
      if (keep.length > 0 && opts?.reconcile !== false) {
        const missing = check(await db.rpc("org_memory_stale_missing", { p_doc: docId, p_keep: keep })) as unknown as number | null;
        out.staled += Number(missing ?? 0);
      }
      return out;
    },
    async listDocEntities(docId) {
      if (!isAdmin) return [];
      const rows = check(await ents().select(ENTITY_COLS).eq("source_doc_id", docId).limit(1000)) as unknown as EntityRow[] | null;
      return (rows ?? []).map((r) => toEntity(r));
    },
    async upsertRelationships(docId, rels, _at, opts): Promise<UpsertRelationshipsResult> {
      void _at; // the database stamps extracted_at itself
      if (!isAdmin) throw DENIED;
      const out: UpsertRelationshipsResult = { created: 0, updated: 0, staled: 0, unchanged: 0, skipped: 0 };
      const keep: string[] = [];
      for (const r of rels) {
        const stable = stableRelationshipId(r.from_entity_id, r.relation_type, r.to_entity_id);
        if (keep.includes(stable)) continue;
        keep.push(stable);
        const res = check(await db.rpc("org_relationship_upsert", {
          p_doc: docId, p_stable: stable, p_from: r.from_entity_id, p_to: r.to_entity_id, p_type: r.relation_type, p_evidence: r.evidence, p_basis: r.basis, p_confidence: r.confidence,
        })) as unknown as keyof UpsertRelationshipsResult;
        if (res in out) out[res] += 1;
      }
      // An extraction that produced NO valid link proves nothing about what the document states, so it never stales existing (possibly reviewed) links.
      if (keep.length > 0 && opts?.reconcile !== false) {
        const missing = check(await db.rpc("org_relationship_stale_missing", { p_doc: docId, p_keep: keep })) as unknown as number | null;
        out.staled += Number(missing ?? 0);
      }
      return out;
    },
    async markExtracted(docId, hash, error) {
      if (!isAdmin) throw DENIED;
      check(await db.rpc("org_memory_mark_extracted", { p_doc: docId, p_hash: hash, p_error: error }));
    },
  };

  const runs: OrgMemoryAccess["runs"] = {
    async start() {
      if (!isAdmin) return { ok: false, reason: "forbidden" };
      try {
        const id = check(await db.rpc("org_memory_run_start")) as unknown as string;
        return { ok: true, id };
      } catch (e) {
        if (e instanceof Busy) return { ok: false, reason: "busy" };
        if (e instanceof UserFacingError) return { ok: false, reason: "forbidden" };
        throw e;
      }
    },
    async finish(id, status, report) {
      if (!isAdmin) throw DENIED;
      check(await db.rpc("org_memory_run_finish", { p_run: id, p_status: status, p_report: report }));
    },
  };

  return { reader, writer, runs };
}
