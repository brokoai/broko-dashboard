import type { KnowledgeRepo } from "@/lib/knowledge/repo";
import { LIMITS, type KnowledgeInput, type KnowledgeKind } from "@/lib/knowledge/types";
import type { OrgEntity, OrgMemoryReader, SourceDoc } from "./types";

/**
 * L1 -> L2. A reviewed L1 record can be PROPOSED to the existing Knowledge Base; that creates a PROPOSED Knowledge item exactly like a person's own
 * submission, and the existing workflow (administrator approval, supersession, expiry, conflict detection, redaction) takes over. Nothing here approves,
 * edits or overwrites an approved item, and `supersedes_id` is only ever passed when the caller names the approved item to replace.
 */

/**
 * Promotion is always ORGANIZATION scope (an L1 record belongs to no precon project). The database only allows two kinds there for a manual
 * submission: "decision" and "procedure" ("correction" needs source_type 'correction', and "project_note" needs project scope: migration 0009
 * constraints knowledge_project_note_needs_project and knowledge_source_matches_kind; the input schema repeats the first). So the mapping is total
 * and every value must stay in ORG_SCOPE_KINDS (tests/org-memory-promote.test.ts reads the constraint from the migration to prove it).
 * Before the fix every type other than decision/commitment became "project_note", which the database rejects (23514) at organization scope.
 */
export const ORG_SCOPE_KINDS = ["decision", "procedure"] as const satisfies readonly KnowledgeKind[];
export const KIND: Record<OrgEntity["entity_type"], (typeof ORG_SCOPE_KINDS)[number]> = {
  decision: "decision", commitment: "decision",
  task: "procedure", action_item: "procedure", deadline: "procedure", client_requirement: "procedure", risk: "procedure", blocker: "procedure",
  project: "procedure", meeting: "procedure", person: "procedure", team: "procedure",
};
const knowledgeKind = (e: OrgEntity): KnowledgeKind => KIND[e.entity_type];

const SENTENCE = (e: OrgEntity): string => {
  const parts = [e.description.trim()];
  if (e.owner) parts.push(`Owner: ${e.owner}.`);
  if (e.team) parts.push(`Team: ${e.team}.`);
  if (e.due) parts.push(`Due: ${e.due}.`);
  if (e.unknowns.length) parts.push(`Not stated in the source: ${e.unknowns.join(", ").replaceAll("_", " ")}.`);
  parts.push(`Basis: ${e.basis}.`);
  return parts.join(" ");
};

export type PromotionResult = { ok: true; entity: OrgEntity; knowledge_id: string } | { ok: false; reason: "not_reviewed" | "stale" | "source_missing" | "knowledge_unavailable" | "refused" | "error" };

export async function proposeToKnowledge(
  deps: { reader: OrgMemoryReader; knowledge: KnowledgeRepo | undefined },
  entityId: string,
  opts: { supersedes_id?: string | null } = {},
): Promise<PromotionResult> {
  if (!deps.knowledge || !deps.knowledge.writable) return { ok: false, reason: "knowledge_unavailable" };
  const e = await deps.reader.getEntity(entityId);
  if (!e) return { ok: false, reason: "refused" }; // not found, or not an administrator: the same answer
  if (e.review_status !== "reviewed") return { ok: false, reason: "not_reviewed" };
  if (e.stale) return { ok: false, reason: "stale" }; // the source changed after review: promote only a current, re-reviewed record
  const doc: SourceDoc | null = await deps.reader.getDocument(e.source_doc_id);
  if (!doc) return { ok: false, reason: "source_missing" };
  const input: KnowledgeInput = {
    kind: knowledgeKind(e), scope: "organization", project_id: null,
    title: e.name.slice(0, LIMITS.title.max).padEnd(LIMITS.title.min, "."),
    body: SENTENCE(e).slice(0, LIMITS.body.max),
    topic: null,
    source_ref: `Notion: ${doc.title}`.slice(0, LIMITS.sourceRef),
    supersedes_id: opts.supersedes_id ?? null,
    expires_on: null,
  };
  try {
    const item = await deps.knowledge.submit(input); // always PROPOSED, authored by the caller; approval stays with the Knowledge workflow
    const next = await deps.reader.markPromotionProposed(e.id, item.id);
    return { ok: true, entity: next, knowledge_id: item.id };
  } catch {
    return { ok: false, reason: "error" };
  }
}
