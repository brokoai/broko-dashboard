import { scanForInjection } from "../injection";
import { stableEntityId } from "./memory-repo";
import { EntityFieldsSchema, type EntityFields, type SourceDoc, type UnknownField } from "./types";

/**
 * Deterministic validation of what the model extracted. The model proposes; this code decides what is kept. Nothing is trusted because it was written
 * confidently: an entity survives only if its evidence really exists in the stored source, and an owner, team or date survives only if it literally
 * appears in the segments the entity cites. Otherwise the field is emptied and listed under `unknowns`: never guessed, never "corrected".
 */

export const MAX_ENTITIES_PER_DOC = 60;
const NEEDS_OWNER = new Set(["task", "action_item", "commitment", "risk", "blocker"]);
const NEEDS_DUE = new Set(["task", "action_item", "commitment", "deadline"]);

export interface ValidationReport {
  entities: EntityFields[];
  rejected: number;
  owners_dropped: number;
  dates_dropped: number;
  /** Rejection reasons by fixed code (never source text). */
  reasons: Record<string, number>;
}

const squash = (s: string): string => s.normalize("NFC").toLowerCase().replace(/\s+/g, " ").trim();
const appears = (needle: string, haystack: string): boolean => {
  const n = squash(needle).replace(/^@/, "");
  return n.length >= 2 && squash(haystack).includes(n);
};

export function validateExtraction(doc: Pick<SourceDoc, "id" | "segments">, raw: unknown): ValidationReport {
  const report: ValidationReport = { entities: [], rejected: 0, owners_dropped: 0, dates_dropped: 0, reasons: {} };
  const reject = (why: string) => { report.rejected += 1; report.reasons[why] = (report.reasons[why] ?? 0) + 1; };
  const list = Array.isArray(raw) ? raw : [];
  const seg = new Map(doc.segments.map((s) => [s.id, s]));
  const seen = new Set<string>();

  for (const item of list.slice(0, MAX_ENTITIES_PER_DOC * 2)) {
    if (report.entities.length >= MAX_ENTITIES_PER_DOC) { reject("over_cap"); continue; }
    const parsed = EntityFieldsSchema.safeParse(item);
    if (!parsed.success) { reject("shape"); continue; }
    const p = parsed.data;
    if (scanForInjection(p.name, p.description).suspected) { reject("unsafe"); continue; }

    const evidence = [...new Set(p.evidence)];
    const cited = evidence.map((id) => seg.get(id));
    // Every cited segment must exist in the stored document and must not be instruction-like (flagged text was never shown to the model).
    if (cited.some((s) => !s || s.flagged || !s.text.trim())) { reject("evidence"); continue; }
    const citedText = cited.map((s) => s!.text).join("\n");

    // A person or team is only real here if the source actually names it.
    if ((p.entity_type === "person" || p.entity_type === "team") && !appears(p.name, citedText)) { reject("name_not_in_evidence"); continue; }

    const unknowns = new Set<UnknownField>(p.unknowns ?? []);
    let owner = p.owner ?? null;
    let team = p.team ?? null;
    let due = p.due ?? null;
    if (owner && !appears(owner, citedText)) { owner = null; report.owners_dropped += 1; }
    if (team && !appears(team, citedText)) { team = null; report.owners_dropped += 1; }
    if (due && !appears(due, citedText)) { due = null; report.dates_dropped += 1; }
    if (p.basis === "unknown") { if (owner || due) { report.owners_dropped += owner ? 1 : 0; report.dates_dropped += due ? 1 : 0; } owner = null; due = null; }
    if (!owner && NEEDS_OWNER.has(p.entity_type)) unknowns.add("owner");
    if (!team && p.entity_type === "team") unknowns.delete("team");
    if (!due && NEEDS_DUE.has(p.entity_type)) unknowns.add("due");
    // A field that is present is, by definition, not unknown.
    if (owner) unknowns.delete("owner");
    if (team) unknowns.delete("team");
    if (due) unknowns.delete("due");

    const stable = stableEntityId(doc.id, p.entity_type, p.name);
    if (seen.has(stable)) { reject("duplicate"); continue; }
    seen.add(stable);
    // Anything inferred (not stated) can never be reported as high confidence.
    const confidence = p.basis === "inferred" || p.basis === "unknown" ? (p.confidence === "high" ? "medium" : p.confidence) : p.confidence;
    report.entities.push({
      entity_type: p.entity_type, name: p.name, description: p.description, evidence: evidence.sort((a, b) => Number(a.slice(1)) - Number(b.slice(1))),
      basis: p.basis, confidence, owner, team, due, unknowns: [...unknowns].sort(),
    });
  }
  return report;
}
