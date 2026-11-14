import { z } from "zod";
import { ENTITY_TYPES, RELATION_TYPES, type OrgEntity, type OrgRelationshipView, type SourceDoc } from "../org-memory/types";
import type { ToolContract, ToolRun } from "./tools";

/**
 * Registry tools over persistent organizational memory (Phase 2A). Read-only, ADMINISTRATOR-only (the Notion integration is org-wide, so employee-level
 * source permissions cannot be established; see org-memory/types.ts), and served through the user-scoped OrgMemoryReader on the Brain context. When no
 * reader is configured they answer "not connected". The reader independently refuses non-administrators, so a role bypass would still read nothing.
 *
 * Records they return are PROPOSED intelligence unless `review` says reviewed: the review state travels with every record so nothing is passed off as
 * approved knowledge. Approved organizational knowledge remains the Knowledge Base (broko.knowledge.list).
 */

/**
 * Relationships (migration 0014) are OFF unless BROKO_ORG_RELATIONSHIPS=1. 0014 is proposed and not applied to any database, so by default the model is not
 * offered memory.relationships.find and ingestion does not extract relationships; turning this on before 0014 exists would only produce database errors.
 */
export const relationshipsEnabled = (env: Record<string, string | undefined>): boolean => env.BROKO_ORG_RELATIONSHIPS === "1";
export const RELATIONSHIP_TOOL = "memory.relationships.find";

export const MEMORY_TOOLS = ["memory.entities.find", "memory.sources.read", "memory.relationships.find"] as const;

export interface MemoryFindNative { entities: OrgEntity[]; docs: SourceDoc[]; budget_reached?: boolean; /** The typed search found nothing, so the same query was repeated WITHOUT the type (the type is only a hint). */ untyped_fallback?: boolean }
export interface MemoryReadNative { doc: SourceDoc }
export interface MemoryRelNative { relationships: OrgRelationshipView[]; docs: SourceDoc[]; budget_reached?: boolean }

const Find = z.object({
  entity_type: z.enum(ENTITY_TYPES).optional().describe("Optional HINT, not a guaranteed classification: a record may be filed under a different type than you expect. Leave it out unless the user names a type."),
  query: z.string().trim().min(1).max(120).optional(),
  limit: z.number().int().min(1).max(25).default(10),
}).strict();
const Rel = z.object({
  entity_id: z.string().regex(/^[0-9a-fA-F-]{36}$/).optional(),
  query: z.string().trim().min(1).max(120).optional(),
  relation_type: z.enum(RELATION_TYPES).optional(),
  limit: z.number().int().min(1).max(25).default(10),
}).strict();
const Read = z.object({ id: z.string().regex(/^[A-Za-z0-9_=-]{1,200}$/) }).strict();

const MAX_DOCS = 5;
const asc = <I>(t: ToolContract<I>): ToolContract<unknown> => t as unknown as ToolContract<unknown>;
const base = { requires: "admin" as const, timeoutMs: 8000, system: "broko_memory" as const, access: "read" as const };

const context = (e: OrgEntity): string => {
  const bits = [`${e.review_status}${e.stale ? ", source changed since" : ""}`, `basis ${e.basis}`, e.owner ? `owner ${e.owner}` : "owner not stated", ...(e.team ? [`team ${e.team}`] : []), ...(e.due ? [`due ${e.due}`] : [])];
  return bits.join("; ").slice(0, 120);
};

export function memoryTools(): ToolContract<unknown>[] {
  return [
    asc({
      ...base, id: "memory.entities.find",
      description: "Find people, teams, projects, meetings, decisions, tasks, action items, commitments, deadlines, risks, blockers or client requirements extracted from the company's stored Notion pages. Records are proposed (unreviewed) unless marked reviewed. Each comes with its evidence segments. `query` is matched word by word against names, descriptions, owners and teams: pass one or two distinctive keywords, not a whole question. `entity_type` is only a hint: avoid guessing a restrictive type when unsure (if a typed search finds nothing the same query is repeated without the type, and the result says so; every record states its own type). An empty result does not by itself mean the organization has no such knowledge.",
      input: Find, provenance: "Stored Notion page (title, link) and the evidence segments the record cites.",
      run: async (i: z.infer<typeof Find>, ctx): Promise<ToolRun> => {
        const memory = ctx.brain.orgMemory;
        if (!memory) return { ok: false, reason: "not_connected" };
        let outcome = { budget_reached: false };
        let entities = await memory.findEntities({ ...(i.entity_type ? { entity_type: i.entity_type } : {}), ...(i.query ? { query: i.query } : {}), limit: i.limit, outcome });
        // The type is a hint, not a gate: a typed search that finds nothing is repeated ONCE without the type, but only when there is a query to search for.
        // An error from the first search is never caught here (it propagates and the call fails), so a failure is never retried. Same reader, same
        // authorization, same archived / rejected / stale handling as the typed search: only the type filter differs.
        let untypedFallback = false;
        if (entities.length === 0 && i.entity_type && i.query) {
          untypedFallback = true;
          outcome = { budget_reached: false };
          entities = await memory.findEntities({ query: i.query, limit: i.limit, outcome });
        }
        const docs = new Map<string, SourceDoc>();
        for (const e of entities) {
          if (docs.has(e.source_doc_id) || docs.size >= MAX_DOCS) continue;
          const d = await memory.getDocument(e.source_doc_id);
          if (d) docs.set(d.id, d);
        }
        const at = ctx.now.toISOString();
        const native: MemoryFindNative = { entities, docs: [...docs.values()], ...(outcome.budget_reached ? { budget_reached: true } : {}), ...(untypedFallback ? { untyped_fallback: true } : {}) };
        return {
          ok: true, native,
          data: entities.map((e) => ({ system: "broko_memory" as const, record_id: e.id, title: `${e.entity_type.replace("_", " ")}: ${e.name}`, excerpt: e.description, ...(docs.get(e.source_doc_id)?.url ? { url: docs.get(e.source_doc_id)!.url! } : {}), owner_context: context(e), retrieved_at: at })),
        };
      },
    }),
    asc({
      ...base, id: "memory.relationships.find",
      description: "Find stored relationships between extracted organizational records (who owns or is assigned what, what blocks or depends on what, which decision came from which meeting, deadlines). Each link names both ends, says whether it is explicit, extracted or inferred, is proposed (unreviewed) unless marked reviewed, and comes with its evidence segments. `query` is matched word by word against the names of both ends: pass one or two distinctive keywords, not a whole question.",
      input: Rel, provenance: "Stored Notion page (title, link) and the evidence segments the relationship cites.",
      run: async (i: z.infer<typeof Rel>, ctx): Promise<ToolRun> => {
        const memory = ctx.brain.orgMemory;
        if (!memory) return { ok: false, reason: "not_connected" };
        const outcome = { budget_reached: false };
        const relationships = await memory.findRelationships({ outcome, ...(i.entity_id ? { entity_id: i.entity_id } : {}), ...(i.query ? { query: i.query } : {}), ...(i.relation_type ? { relation_type: i.relation_type } : {}), limit: i.limit });
        const docs = new Map<string, SourceDoc>();
        for (const r of relationships) {
          if (docs.has(r.source_doc_id) || docs.size >= MAX_DOCS) continue;
          const d = await memory.getDocument(r.source_doc_id);
          if (d) docs.set(d.id, d);
        }
        const at = ctx.now.toISOString();
        const native: MemoryRelNative = { relationships, docs: [...docs.values()], ...(outcome.budget_reached ? { budget_reached: true } : {}) };
        return {
          ok: true, native,
          data: relationships.map((r) => ({ system: "broko_memory" as const, record_id: r.id, title: `${r.from.name} ${r.relation_type} ${r.to.name}`.slice(0, 200), excerpt: `${r.from.entity_type} ${r.relation_type} ${r.to.entity_type}`, ...(docs.get(r.source_doc_id)?.url ? { url: docs.get(r.source_doc_id)!.url! } : {}), owner_context: `${r.review_status}${r.stale ? ", source changed since" : ""}; basis ${r.basis}`.slice(0, 120), retrieved_at: at })),
        };
      },
    }),
    asc({
      ...base, id: "memory.sources.read",
      description: "Read one stored source page (its numbered segments), by the source id a memory record gave.",
      input: Read, provenance: "Stored Notion page: id, URL, last edited time and content hash.",
      run: async (i: z.infer<typeof Read>, ctx): Promise<ToolRun> => {
        const memory = ctx.brain.orgMemory;
        if (!memory) return { ok: false, reason: "not_connected" };
        const doc = await memory.getDocument(i.id);
        if (!doc) return { ok: false, reason: "error" };
        const native: MemoryReadNative = { doc };
        return { ok: true, native, data: [{ system: "broko_memory", record_id: doc.id, title: doc.title, ...(doc.url ? { url: doc.url } : {}), owner_context: `stored Notion page, ${doc.segments.length} segments`, retrieved_at: doc.ingested_at }] };
      },
    }),
  ];
}
