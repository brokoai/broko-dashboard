import { createHash, randomUUID } from "node:crypto";
import { rankByHits, searchWords, tokenHits } from "./query";
import type {
  OrgIngestRuns, OrgMemoryAccess, RunStatus,
  DocChange, DocInput, EntityFields, EntityQuery, FailureCode, OrgEntity, OrgMemoryReader, OrgMemoryWriter, ReviewAction, SourceDoc, UpsertEntitiesResult,
  OrgRelationship, OrgRelationshipView, RelationshipFields, RelationshipQuery, UpsertRelationshipsResult,
} from "./types";

/**
 * In-memory implementation of the org-memory ports: the reference behaviour the Supabase adapter and the proposed SQL (0013) must match, and what the
 * tests and the demo use. The Reader refuses everyone who is not an administrator (fail closed), exactly as the RLS policies do.
 */

export const normalizeText = (s: string): string => s.normalize("NFC").replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, "").replace(/[ \t]+/g, " ").replace(/\s*\n\s*/g, "\n").trim();
export const hashContent = (title: string, segmentTexts: readonly string[]): string =>
  createHash("sha256").update(normalizeText(title)).update("\u0000").update(segmentTexts.map(normalizeText).join("\u0000")).digest("hex");
export const stableEntityId = (docId: string, type: string, name: string): string =>
  createHash("sha256").update(`${docId}\u0000${type}\u0000${normalizeText(name).toLowerCase()}`).digest("hex").slice(0, 24);

/** Identity of a relationship: the same (from, type, to) found again keeps its id. */
export const stableRelationshipId = (fromId: string, type: string, toId: string): string =>
  createHash("sha256").update(`${fromId}\u0000${type}\u0000${toId}`).digest("hex").slice(0, 24);
const sameRel = (a: Pick<RelationshipFields, "evidence" | "basis" | "confidence">, b: Pick<RelationshipFields, "evidence" | "basis" | "confidence">): boolean =>
  a.basis === b.basis && a.confidence === b.confidence && a.evidence.join(",") === b.evidence.join(",");
/** Same rule as org_relationship_endpoint_ok in 0014 and isEligibleEndpoint in relationships.ts (kept inline: relationships.ts imports this module). */
const endpointOk = (e: OrgEntity | undefined, docs: Map<string, SourceDoc>): boolean => {
  if (!e || e.review_status === "rejected") return false;
  const d = docs.get(e.source_doc_id);
  return Boolean(d && !d.archived && !(e.stale && !e.pending_revision));
};

const sameFields = (a: EntityFields, b: EntityFields): boolean =>
  a.description === b.description && a.basis === b.basis && a.confidence === b.confidence && a.owner === b.owner && a.team === b.team && a.due === b.due
  && a.evidence.join(",") === b.evidence.join(",") && [...a.unknowns].sort().join(",") === [...b.unknowns].sort().join(",");

const pick = (e: EntityFields): EntityFields => ({
  entity_type: e.entity_type, name: e.name, description: e.description, evidence: [...e.evidence], basis: e.basis, confidence: e.confidence,
  owner: e.owner, team: e.team, due: e.due, unknowns: [...e.unknowns],
});

export interface MemoryOrgStore {
  writer: OrgMemoryWriter;
  /** A reader scoped to one signed-in user. Anything but an administrator reads nothing and changes nothing. */
  readerFor(user: { id: string; role: string } | null): OrgMemoryReader;
  /** Reader, writer and run lock for one signed-in user, as the Supabase adapter provides them. A non-administrator's writes throw and its run is refused. */
  accessFor(user: { id: string; role: string } | null): OrgMemoryAccess;
  /** Finished runs, newest last (counts only). */
  runLog(): { status: RunStatus; report: Record<string, number | string | null> }[];
  /** Test/inspection hook: every stored document, regardless of user. */
  snapshot(): { docs: SourceDoc[]; entities: OrgEntity[]; relationships: OrgRelationship[] };
}

const isAdmin = (u: { id: string; role: string } | null): u is { id: string; role: "admin" } => Boolean(u && u.role === "admin");

export function createMemoryOrgStore(clock: () => Date = () => new Date()): MemoryOrgStore {
  const docs = new Map<string, SourceDoc>(); // by id
  const byKey = new Map<string, string>(); // provider|workspace|source -> id
  const entities = new Map<string, OrgEntity>();
  const relationships = new Map<string, OrgRelationship>();
  const key = (p: string, w: string, s: string) => `${p}|${w}|${s}`;

  const writer: OrgMemoryWriter = {
    async getDoc(provider, workspaceId, sourceId) {
      const id = byKey.get(key(provider, workspaceId, sourceId));
      return id ? { ...docs.get(id)! } : null;
    },
    async upsertDoc(input: DocInput) {
      const k = key(input.provider, input.workspace_id, input.source_id);
      const existingId = byKey.get(k);
      const normSegments = input.segments.map((s) => ({ ...s, text: normalizeText(s.text) })).filter((s) => s.text);
      const content_hash = hashContent(input.title, normSegments.map((s) => s.text));
      const content = normSegments.map((s) => s.text).join("\n");
      const base = {
        url: input.url, title: input.title, doc_type: input.doc_type, content, segments: normSegments, coverage: input.coverage,
        content_hash, last_edited: input.last_edited, ingested_at: input.ingested_at, owner: input.owner,
      };
      if (!existingId) {
        const doc: SourceDoc = {
          id: randomUUID(), provider: input.provider, workspace_id: input.workspace_id, source_id: input.source_id, ...base, access_scope: "admin",
          sync_status: "synced", attempts: 0, last_error: null, extracted_hash: null, extraction_error: null, archived: false,
        };
        docs.set(doc.id, doc); byKey.set(k, doc.id);
        return { doc: { ...doc }, change: "created" as DocChange };
      }
      const prev = docs.get(existingId)!;
      const changed = prev.content_hash !== content_hash;
      // Unchanged content refreshes only the bookkeeping (last_edited, sync state); the stored text, segments and extraction stay exactly as they were.
      const next: SourceDoc = changed
        ? { ...prev, ...base, sync_status: "synced", attempts: 0, last_error: null, archived: false }
        : { ...prev, last_edited: input.last_edited, ingested_at: input.ingested_at, url: input.url ?? prev.url, sync_status: "synced", attempts: 0, last_error: null, archived: false };
      docs.set(existingId, next);
      return { doc: { ...next }, change: (changed ? "changed" : "unchanged") as DocChange };
    },
    async recordFailure(provider, workspaceId, sourceId, meta, code: FailureCode, at) {
      const k = key(provider, workspaceId, sourceId);
      const id = byKey.get(k);
      if (id) {
        const prev = docs.get(id)!;
        const next: SourceDoc = { ...prev, sync_status: "failed", attempts: prev.attempts + 1, last_error: code, ingested_at: prev.ingested_at };
        docs.set(id, next);
        return { ...next };
      }
      // A source that has never been read leaves a failed placeholder with NO content: nothing is invented to fill it.
      const doc: SourceDoc = {
        id: randomUUID(), provider, workspace_id: workspaceId, source_id: sourceId, url: meta.url, title: meta.title, doc_type: "page", content: "", segments: [],
        coverage: { complete: false, gaps: [], blocks_read: 0 }, content_hash: "", last_edited: null, ingested_at: at, owner: null, access_scope: "admin",
        sync_status: "failed", attempts: 1, last_error: code, extracted_hash: null, extraction_error: null, archived: false,
      };
      docs.set(doc.id, doc); byKey.set(k, doc.id);
      return { ...doc };
    },
    async listActiveSourceIds(provider, workspaceId) {
      return [...docs.values()].filter((d) => d.provider === provider && d.workspace_id === workspaceId && !d.archived).map((d) => d.source_id);
    },
    async archiveDoc(provider, workspaceId, sourceId) {
      const id = byKey.get(key(provider, workspaceId, sourceId));
      if (!id) return;
      const prev = docs.get(id)!;
      docs.set(id, { ...prev, archived: true, sync_status: "archived" });
      // Entities of a source that no longer exists are no longer supported by it: they are marked stale, never deleted (review history is kept).
      for (const e of entities.values()) if (e.source_doc_id === id) entities.set(e.id, { ...e, stale: true });
      for (const r of relationships.values()) if (r.source_doc_id === id) relationships.set(r.id, { ...r, stale: true });
    },
    async listRetryable(provider, workspaceId, maxAttempts) {
      return [...docs.values()].filter((d) => d.provider === provider && d.workspace_id === workspaceId && d.sync_status === "failed" && !d.archived && d.attempts < maxAttempts).map((d) => ({ ...d }));
    },
    async listUnextracted(provider, workspaceId) {
      return [...docs.values()]
        .filter((d) => d.provider === provider && d.workspace_id === workspaceId && !d.archived && d.sync_status === "synced" && d.content_hash && d.extracted_hash !== d.content_hash)
        .map((d) => ({ ...d }));
    },
    async upsertEntities(docId, incoming, at, opts): Promise<UpsertEntitiesResult> {
      const out: UpsertEntitiesResult = { created: 0, updated: 0, staled: 0, unchanged: 0 };
      const seen = new Set<string>();
      const existing = new Map([...entities.values()].filter((e) => e.source_doc_id === docId).map((e) => [e.stable_id, e]));
      for (const raw of incoming) {
        const fields = pick(raw);
        const stable = stableEntityId(docId, fields.entity_type, fields.name);
        if (seen.has(stable)) continue; // the same entity named twice in one extraction counts once
        seen.add(stable);
        const prev = existing.get(stable);
        if (!prev) {
          const e: OrgEntity = { ...fields, id: randomUUID(), stable_id: stable, source_doc_id: docId, extracted_at: at, review_status: "proposed", stale: false, pending_revision: null, knowledge_item_id: null, history: [] };
          entities.set(e.id, e); out.created += 1; continue;
        }
        if (prev.review_status === "rejected") { out.unchanged += 1; continue; } // a rejected record is never brought back by a re-extraction
        if (prev.review_status === "proposed") {
          if (sameFields(prev, fields) && !prev.stale) { out.unchanged += 1; continue; }
          entities.set(prev.id, { ...prev, ...fields, extracted_at: at, stale: false, pending_revision: null }); out.updated += 1; continue;
        }
        // Reviewed (or already proposed for promotion): the approved record is NEVER overwritten. A different extraction waits as a pending revision.
        if (sameFields(prev, fields)) { out.unchanged += 1; if (prev.stale || prev.pending_revision) entities.set(prev.id, { ...prev, stale: false, pending_revision: null }); continue; }
        entities.set(prev.id, { ...prev, stale: true, pending_revision: { ...fields, extracted_at: at } }); out.staled += 1;
      }
      // An extraction with NO valid entity proves nothing about what the document states (same rule as relationships): it never stales existing records.
      if (seen.size > 0 && opts?.reconcile !== false) for (const prev of existing.values()) {
        if (seen.has(prev.stable_id) || prev.review_status === "rejected" || prev.stale) continue;
        entities.set(prev.id, { ...prev, stale: true }); out.staled += 1; // the source no longer states it
      }
      return out;
    },
    async markExtracted(docId, hash, error) {
      const d = docs.get(docId);
      if (!d) return;
      docs.set(docId, { ...d, extracted_hash: error ? d.extracted_hash : hash, extraction_error: error });
    },
    async listDocEntities(docId) {
      return [...entities.values()].filter((e) => e.source_doc_id === docId).map((e) => ({ ...e }));
    },
    async upsertRelationships(docId, incoming, at, opts): Promise<UpsertRelationshipsResult> {
      const out: UpsertRelationshipsResult = { created: 0, updated: 0, staled: 0, unchanged: 0, skipped: 0 };
      const doc = docs.get(docId);
      const seen = new Set<string>();
      const existing = new Map([...relationships.values()].filter((r) => r.source_doc_id === docId).map((r) => [r.stable_id, r]));
      const segIds = new Set((doc?.segments ?? []).filter((s) => !s.flagged).map((s) => s.id));
      for (const raw of incoming) {
        const f = entities.get(raw.from_entity_id);
        const t = entities.get(raw.to_entity_id);
        if (raw.from_entity_id === raw.to_entity_id || !endpointOk(f, docs) || !endpointOk(t, docs) || !doc || doc.archived) { out.skipped += 1; continue; }
        if (f!.source_doc_id !== docId || t!.source_doc_id !== docId) throw new Error("both endpoints must belong to the cited document");
        const evidence = [...new Set(raw.evidence)];
        if (evidence.length === 0 || evidence.some((id) => !segIds.has(id))) throw new Error("evidence does not resolve to segments of the document");
        const fields: RelationshipFields = { ...raw, evidence };
        const stable = stableRelationshipId(raw.from_entity_id, raw.relation_type, raw.to_entity_id);
        if (seen.has(stable)) continue;
        seen.add(stable);
        const prev = existing.get(stable);
        if (!prev) {
          const r: OrgRelationship = { ...fields, id: randomUUID(), stable_id: stable, source_doc_id: docId, extracted_at: at, review_status: "proposed", stale: false, pending_revision: null, history: [] };
          relationships.set(r.id, r); out.created += 1; continue;
        }
        if (prev.review_status === "rejected") { out.unchanged += 1; continue; } // a rejected link never comes back
        if (prev.review_status === "proposed") {
          if (sameRel(prev, fields) && !prev.stale) { out.unchanged += 1; continue; }
          relationships.set(prev.id, { ...prev, evidence: fields.evidence, basis: fields.basis, confidence: fields.confidence, extracted_at: at, stale: false, pending_revision: null }); out.updated += 1; continue;
        }
        // reviewed: NEVER overwritten. A different extraction waits as a pending revision.
        if (sameRel(prev, fields)) { out.unchanged += 1; if (prev.stale || prev.pending_revision) relationships.set(prev.id, { ...prev, stale: false, pending_revision: null }); continue; }
        relationships.set(prev.id, { ...prev, stale: true, pending_revision: { evidence: fields.evidence, basis: fields.basis, confidence: fields.confidence, extracted_at: at } }); out.staled += 1;
      }
      // An extraction with NO valid link proves nothing about what the document states: it never stales existing (possibly reviewed) links.
      if (incoming.length > 0 && opts?.reconcile !== false) for (const prev of existing.values()) {
        if (seen.has(prev.stable_id) || prev.review_status === "rejected" || prev.stale) continue;
        relationships.set(prev.id, { ...prev, stale: true }); out.staled += 1; // the document no longer states it
      }
      return out;
    },
  };

  const readerFor = (user: { id: string; role: string } | null): OrgMemoryReader => {
    const guard = isAdmin(user);
    const live = (e: OrgEntity): boolean => { const d = docs.get(e.source_doc_id); return Boolean(d && !d.archived); };
    const relLive = (r: OrgRelationship): boolean => { const d = docs.get(r.source_doc_id); return Boolean(d && !d.archived); };
    const relEligible = (r: OrgRelationship): boolean => endpointOk(entities.get(r.from_entity_id), docs) && endpointOk(entities.get(r.to_entity_id), docs);
    const ref = (id: string) => { const e = entities.get(id); return { id, entity_type: e?.entity_type ?? "task", name: e?.name ?? "" } as OrgRelationshipView["from"]; };
    const view = (r: OrgRelationship): OrgRelationshipView => ({ ...r, evidence: [...r.evidence], history: [...r.history], from: ref(r.from_entity_id), to: ref(r.to_entity_id) });
    return {
      async findEntities(q: EntityQuery) {
        if (!guard) return [];
        const words = searchWords(q.query); // word by word, ranked by how many occur (same rule as the Supabase adapter)
        const text = (e: OrgEntity) => `${e.name} ${e.description} ${e.owner ?? ""} ${e.team ?? ""}`;
        const found = [...entities.values()]
          .filter((e) => (q.include_rejected || e.review_status !== "rejected") && live(e) && (!q.entity_type || e.entity_type === q.entity_type) && (!q.source_doc_id || e.source_doc_id === q.source_doc_id)
            && (!words.length || tokenHits(words, text(e)) > 0))
          .sort((a, b) => b.extracted_at.localeCompare(a.extracted_at) || a.name.localeCompare(b.name));
        return rankByHits(found, words, text).slice(0, q.limit).map((e) => ({ ...e }));
      },
      async getEntity(id) { if (!guard) return null; const e = entities.get(id); return e && live(e) ? { ...e } : null; },
      async getDocument(id) { if (!guard) return null; const d = docs.get(id); return d && !d.archived ? { ...d } : null; },
      async listReviewQueue(limit) {
        if (!guard) return [];
        return [...entities.values()].filter((e) => live(e) && (e.review_status === "proposed" || (e.stale && e.pending_revision && e.review_status !== "rejected"))).sort((a, b) => a.extracted_at.localeCompare(b.extracted_at)).slice(0, limit).map((e) => ({ ...e }));
      },
      async review(id, action: ReviewAction, note) {
        if (!guard) throw new Error("only administrators review organizational memory");
        const e = entities.get(id);
        if (!e || !live(e)) throw new Error("not found");
        const event = { at: clock().toISOString(), by: user.id, action, note: note ? note.slice(0, 500) : null };
        let next: OrgEntity;
        if (action === "approve") {
          if (e.review_status !== "proposed") throw new Error("only a proposed record can be approved");
          next = { ...e, review_status: "reviewed" };
        } else if (action === "reject") {
          if (e.review_status === "rejected") throw new Error("already rejected");
          next = { ...e, review_status: "rejected", pending_revision: null };
        } else if (action === "accept_revision") {
          if (!e.pending_revision) throw new Error("no revision is waiting");
          const { extracted_at, ...fields } = e.pending_revision;
          // Accepting a revision supersedes the old values; the old ones stay in the history, and the record needs no second Knowledge approval unless the owner promotes it again.
          next = { ...e, ...fields, extracted_at, stale: false, pending_revision: null, review_status: e.review_status === "promotion_proposed" ? "reviewed" : e.review_status };
        } else {
          if (!e.pending_revision) throw new Error("no revision is waiting");
          next = { ...e, pending_revision: null };
        }
        next.history = [...e.history, event];
        entities.set(id, next);
        return { ...next };
      },
      async markPromotionProposed(id, knowledgeItemId) {
        if (!guard) throw new Error("only administrators promote organizational memory");
        const e = entities.get(id);
        if (!e || !live(e)) throw new Error("not found");
        if (e.review_status !== "reviewed") throw new Error("only a reviewed record can be proposed to the Knowledge Base");
        const next: OrgEntity = { ...e, review_status: "promotion_proposed", knowledge_item_id: knowledgeItemId };
        entities.set(id, next);
        return { ...next };
      },
      async findRelationships(q: RelationshipQuery) {
        if (!guard) return [];
        const words = searchWords(q.query);
        const ends = (r: OrgRelationship) => `${entities.get(r.from_entity_id)?.name ?? ""} ${entities.get(r.to_entity_id)?.name ?? ""}`;
        const found = [...relationships.values()]
          .filter((r) => relLive(r) && (q.include_rejected || (r.review_status !== "rejected" && relEligible(r)))
            && (!q.entity_id || r.from_entity_id === q.entity_id || r.to_entity_id === q.entity_id) && (!q.relation_type || r.relation_type === q.relation_type) && (!q.source_doc_id || r.source_doc_id === q.source_doc_id)
            && (!words.length || [r.from_entity_id, r.to_entity_id].some((id) => tokenHits(words, entities.get(id)?.name ?? "") > 0)))
          .sort((a, b) => b.extracted_at.localeCompare(a.extracted_at) || a.stable_id.localeCompare(b.stable_id));
        return rankByHits(found, words, ends).slice(0, q.limit).map(view);
      },
      async getRelationship(id) { if (!guard) return null; const r = relationships.get(id); return r && relLive(r) ? view(r) : null; },
      async listRelationshipQueue(limit) {
        if (!guard) return [];
        return [...relationships.values()].filter((r) => relLive(r) && r.review_status !== "rejected" && relEligible(r) && (r.review_status === "proposed" || (r.stale && r.pending_revision)))
          .sort((a, b) => a.extracted_at.localeCompare(b.extracted_at)).slice(0, limit).map(view);
      },
      async reviewRelationship(id, action: ReviewAction, note) {
        if (!guard) throw new Error("only administrators review organizational memory");
        const r = relationships.get(id);
        if (!r || !relLive(r)) throw new Error("not found");
        const reason = note?.trim() ? note.trim().slice(0, 500) : null;
        const event = { at: clock().toISOString(), by: user.id, action, note: reason };
        let next: OrgRelationship;
        if (action === "approve") {
          if (r.review_status !== "proposed") throw new Error("only a proposed relationship can be approved");
          if (r.stale) throw new Error("a stale relationship cannot be approved while its source has changed");
          if (!relEligible(r)) throw new Error("an endpoint is no longer eligible");
          if (r.basis === "inferred" && !reason) throw new Error("approving an inferred relationship needs a written reason");
          next = { ...r, review_status: "reviewed" };
        } else if (action === "reject") {
          if (r.review_status === "rejected") throw new Error("already rejected");
          next = { ...r, review_status: "rejected", pending_revision: null };
        } else if (action === "accept_revision") {
          if (!r.pending_revision) throw new Error("no revision is waiting");
          if (!relEligible(r)) throw new Error("an endpoint is no longer eligible");
          if (r.pending_revision.basis === "inferred" && !reason) throw new Error("accepting an inferred revision needs a written reason");
          const { extracted_at, ...fields } = r.pending_revision;
          next = { ...r, ...fields, extracted_at, stale: false, pending_revision: null };
        } else {
          if (!r.pending_revision) throw new Error("no revision is waiting");
          next = { ...r, pending_revision: null };
        }
        next.history = [...r.history, event];
        relationships.set(id, next);
        return view(next);
      },
    };
  };

  // One ingestion slot, like the unique partial index in 0013. Abandoned after 15 minutes.
  let running: { id: string; at: number } | null = null;
  const finished: { status: RunStatus; report: Record<string, number | string | null> }[] = [];
  const accessFor = (user: { id: string; role: string } | null): OrgMemoryAccess => {
    const ok = isAdmin(user);
    const deny = (): never => { throw new Error("only administrators can use organizational memory"); };
    const guarded = Object.fromEntries(Object.entries(writer).map(([k, fn]) => [k, async (...a: unknown[]) => (ok ? (fn as (...x: unknown[]) => unknown)(...a) : deny())])) as unknown as OrgMemoryWriter;
    const runs: OrgIngestRuns = {
      async start() {
        if (!ok) return { ok: false, reason: "forbidden" };
        const now = clock().getTime();
        if (running && now - running.at < 15 * 60_000) return { ok: false, reason: "busy" };
        running = { id: randomUUID(), at: now };
        return { ok: true, id: running.id };
      },
      async finish(id, status, report) {
        if (!ok) deny();
        if (!running || running.id !== id) throw new Error("run not found or already finished");
        running = null;
        finished.push({ status, report });
      },
    };
    return { reader: readerFor(user), writer: guarded, runs };
  };

  return { writer, readerFor, accessFor, runLog: () => [...finished], snapshot: () => ({ docs: [...docs.values()].map((d) => ({ ...d })), entities: [...entities.values()].map((e) => ({ ...e })), relationships: [...relationships.values()].map((r) => ({ ...r })) }) };
}
