import { z } from "zod";
import {
  CONFIDENCES, REL_BASES, RELATION_TYPES,
  type EntityType, type OrgEntity, type RelationType, type RelationshipFields, type SourceDoc,
} from "./types";

/**
 * Phase 2B: deterministic validation of the relationships the model proposed. The model proposes; this code decides what is kept, exactly like validate.ts
 * does for entities. A relationship survives only if
 *   - both endpoints are existing, ELIGIBLE entities of this very document (referenced by the E# refs this module hands out, never by free text),
 *   - the relation type is in the fixed vocabulary and the endpoint types fit it,
 *   - every cited segment exists in the stored document and is not instruction-like,
 *   - every person or team it names really appears in the cited text (no invented owners, assignees or committers).
 * Support for the claim decides its BASIS: "explicit" needs the cited text to be the text BOTH endpoints were extracted from, "extracted" needs it to anchor
 * at least one of them; anything weaker is stored as "inferred" (and counted), never silently kept as stated. An inference is never high confidence.
 */

export const MAX_RELATIONSHIPS_PER_DOC = 120;

const ALL: readonly EntityType[] = ["person", "team", "project", "meeting", "decision", "task", "action_item", "commitment", "deadline", "risk", "blocker", "client_requirement"];
const WORK: readonly EntityType[] = ["task", "action_item", "commitment"];
const ISSUE: readonly EntityType[] = ["risk", "blocker", "client_requirement"];
const WHO: readonly EntityType[] = ["person", "team"];
/** Which (from, to) entity types each relation may connect. RELATES_TO is the deliberately generic link. */
export const TYPE_RULES: Record<RelationType, { from: readonly EntityType[]; to: readonly EntityType[] }> = {
  OWNS: { from: WHO, to: ["project", ...WORK, ...ISSUE, "decision"] },
  ASSIGNED_TO: { from: WORK, to: WHO },
  COMMITTED_TO: { from: WHO, to: [...WORK, "deadline", "decision", "client_requirement"] },
  BELONGS_TO: { from: ["person", "team", "meeting", "decision", "deadline", ...WORK, ...ISSUE], to: ["team", "project"] },
  PART_OF: { from: ["task", "action_item", "project", "team", "deadline"], to: ["project", "team", "task"] },
  RESULTED_IN: { from: ["meeting", "decision", "risk", "blocker", "commitment"], to: ["decision", "task", "action_item", "commitment", "deadline"] },
  DISCUSSED_IN: { from: ["decision", "project", "deadline", ...WORK, ...ISSUE], to: ["meeting"] },
  RAISED_IN: { from: ["decision", "task", "action_item", ...ISSUE], to: ["meeting"] },
  BLOCKS: { from: ["blocker", "risk", "task", "action_item", "decision"], to: ["task", "action_item", "project", "commitment", "deadline", "decision"] },
  DEPENDS_ON: { from: ["task", "action_item", "project", "commitment", "deadline", "decision"], to: ["task", "action_item", "project", "decision", "commitment", "deadline"] },
  HAS_DEADLINE: { from: ["task", "action_item", "project", "commitment", "decision"], to: ["deadline"] },
  RELATES_TO: { from: ALL, to: ALL },
};

/** An entity may be linked to only while it is not rejected and the source still states it (a stale record with no waiting revision is not current). */
export const isEligibleEndpoint = (e: Pick<OrgEntity, "review_status" | "stale" | "pending_revision">): boolean =>
  e.review_status !== "rejected" && !(e.stale && !e.pending_revision);

/** The refs (E1, E2, ...) the model sees and the validator resolves. Deterministic: eligible entities ordered by stable id. */
export function entityRefs(entities: readonly OrgEntity[]): Map<string, OrgEntity> {
  const eligible = entities.filter(isEligibleEndpoint).sort((a, b) => a.stable_id.localeCompare(b.stable_id));
  return new Map(eligible.map((e, i) => [`E${i + 1}`, e]));
}

export const RelationshipRawSchema = z.object({
  from: z.string().regex(/^E\d{1,4}$/),
  to: z.string().regex(/^E\d{1,4}$/),
  relation_type: z.enum(RELATION_TYPES),
  evidence: z.array(z.string().regex(/^S\d{1,5}$/)).min(1).max(8),
  basis: z.enum(REL_BASES),
  confidence: z.enum(CONFIDENCES),
}).strict();

export interface RelationshipValidation {
  relationships: RelationshipFields[];
  rejected: number;
  /** Kept, but stored as "inferred" because the cited text did not support the stronger basis the model claimed. */
  downgraded: number;
  /** Rejection reasons by fixed code (never source text). */
  reasons: Record<string, number>;
}

const squash = (s: string): string => s.normalize("NFC").toLowerCase().replace(/\s+/g, " ").trim();
const appears = (needle: string, haystack: string): boolean => { const n = squash(needle).replace(/^@/, ""); return n.length >= 2 && squash(haystack).includes(n); };

export function validateRelationships(doc: Pick<SourceDoc, "segments">, entities: readonly OrgEntity[], raw: unknown): RelationshipValidation {
  const out: RelationshipValidation = { relationships: [], rejected: 0, downgraded: 0, reasons: {} };
  const reject = (why: string) => { out.rejected += 1; out.reasons[why] = (out.reasons[why] ?? 0) + 1; };
  const refs = entityRefs(entities);
  const seg = new Map(doc.segments.map((s) => [s.id, s]));
  const seen = new Set<string>();
  const list = Array.isArray(raw) ? raw : [];

  for (const item of list.slice(0, MAX_RELATIONSHIPS_PER_DOC * 2)) {
    if (out.relationships.length >= MAX_RELATIONSHIPS_PER_DOC) { reject("over_cap"); continue; }
    const parsed = RelationshipRawSchema.safeParse(item);
    if (!parsed.success) { reject("shape"); continue; }
    const p = parsed.data;
    const from = refs.get(p.from); const to = refs.get(p.to);
    if (!from || !to) { reject("endpoint_missing"); continue; }
    if (from.id === to.id) { reject("self"); continue; }
    const rule = TYPE_RULES[p.relation_type];
    if (!rule.from.includes(from.entity_type) || !rule.to.includes(to.entity_type)) { reject("type_mismatch"); continue; }

    const evidence = [...new Set(p.evidence)];
    const cited = evidence.map((id) => seg.get(id));
    if (cited.some((s) => !s || s.flagged || !s.text.trim())) { reject("evidence"); continue; }
    const citedText = cited.map((s) => s!.text).join("\n");
    // A person or team on either end is only real here if the cited text names them: nobody is made an owner, assignee or committer by guesswork.
    if ([from, to].some((e) => (e.entity_type === "person" || e.entity_type === "team") && !appears(e.name, citedText))) { reject("who_not_in_evidence"); continue; }

    const key = `${from.id}|${p.relation_type}|${to.id}`;
    if (seen.has(key)) { reject("duplicate"); continue; }
    seen.add(key);

    const cites = new Set(evidence);
    const anchorsFrom = from.evidence.some((id) => cites.has(id));
    const anchorsTo = to.evidence.some((id) => cites.has(id));
    let basis = p.basis;
    if ((basis === "explicit" && !(anchorsFrom && anchorsTo)) || (basis === "extracted" && !(anchorsFrom || anchorsTo))) { basis = "inferred"; out.downgraded += 1; }
    const confidence = basis === "inferred" && p.confidence === "high" ? "medium" : p.confidence;
    out.relationships.push({
      relation_type: p.relation_type, from_entity_id: from.id, to_entity_id: to.id,
      evidence: evidence.sort((a, b) => Number(a.slice(1)) - Number(b.slice(1))), basis, confidence,
    });
  }
  return out;
}
