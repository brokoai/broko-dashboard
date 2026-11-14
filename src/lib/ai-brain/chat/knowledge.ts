import { canSeeItem, conflictGroups, ageInDays, isCurrent, isStale } from "@/lib/knowledge/policy";
import { kindHints, searchKnowledge, significantTerms } from "@/lib/knowledge/search";
import { KIND_LABEL, STALE_AFTER_DAYS, type KnowledgeItem } from "@/lib/knowledge/types";
import type { PreconProject } from "@/lib/precon/types";
import { scanForInjection } from "../injection";
import { loadKnowledgeViaTools } from "../assistant/brain-tools";
import { finish } from "./brain";
import type { RoutedIntent } from "./intent";
import { LABELS, clean, failed, provenanceOf, readable, refused, safeRef, type Outcome, type SourceAdapter } from "./retrieval";
import type { BrainChatContext, ChatItem, ChatReply, ChatSection, RetrievedRecord, SourceReport } from "./types";

/**
 * Approved organizational knowledge for the Central AI Brain. There is no second chatbot and no model here.
 *
 *   - Only APPROVED items that are in effect and not expired are ever read. Proposed, rejected, superseded and expired items cannot
 *     reach an answer: the repository (row level security) does not return them, and this adapter checks again.
 *   - Project knowledge is used only for projects this user may see (checked against the user-scoped Pre-Construction repository);
 *     if that cannot be established, project items are withheld rather than guessed.
 *   - Conflicting items (same topic, different content) are reported side by side, never silently resolved. Items nobody has
 *     reviewed for a long time are labelled. Every item is cited with its kind, approver, approval date and source note.
 *   - Knowledge text is untrusted data: truncated, scanned for instruction-like wording, shown as text, never interpreted.
 */

const MAX_SHOWN = 5;
const EXCERPT = 400;
const HREF = "/knowledge";

/** Questions that are plainly about what the organization has decided or documented. */
const KNOWLEDGE_TRIGGER =
  /\b(what(?:'s| is| are| was| were)? (?:our|the) (?:procedures?|process(?:es)?|polic(?:y|ies)|guidelines?|standards?|rules?|conventions?)|how (?:do|should|did) we|what did we decide|what does (?:our|the) (?:approved )?(?:procedures?|process(?:es)?|polic(?:y|ies)|guidelines?|standards?|rules?) say|(?:our|the) approved (?:procedures?|process(?:es)?|polic(?:y|ies)|guidelines?|standards?)|what (?:was|were) (?:the )?decisions?|(?:company|organi[sz]ation(?:al)?|team) (?:knowledge|procedures?|polic(?:y|ies)|decisions?)|knowledge base|approved knowledge|any (?:notes?|corrections?|decisions?) (?:on|about|for)|project notes?|corrections? (?:on|about|for))\b/i;

export interface Loaded { outcome: Outcome; items: KnowledgeItem[]; projectNames: Map<string, string>; withheld: number }

/** Reads current approved knowledge this user may see, re-applying the visibility rules. Reads only; never writes. */
export async function loadKnowledge(ctx: BrainChatContext): Promise<Loaded> {
  const repo = ctx.repo.knowledge;
  const empty = (outcome: Outcome): Loaded => ({ outcome, items: [], projectNames: new Map(), withheld: 0 });
  if (!repo) return empty(refused("knowledge", "not_connected", "Organizational knowledge is not connected to this backend."));
  let raw: KnowledgeItem[];
  try { raw = await repo.listCurrent(); } catch { return empty(failed("knowledge")); }

  const projectNames = new Map<string, string>();
  let visible: Set<string> | null = null;
  if (raw.some((i) => i.scope === "project")) {
    try {
      const projects = await ctx.repo.precon?.listProjects();
      if (projects) { visible = new Set(projects.map((p) => p.id)); for (const p of projects) projectNames.set(p.id, p.name); }
    } catch { visible = null; }
  }
  const items = raw.filter((i) => canSeeItem(ctx.user, i, visible, ctx.now) && isCurrent(i, ctx.now)).slice(0, 500);
  const withheld = raw.filter((i) => i.scope === "project" && !(visible && i.project_id && visible.has(i.project_id))).length;
  const records = items.map((i) => recordOf(ctx, i));
  const report = readable(ctx, "knowledge", withheld ? "Approved knowledge. Some project notes could not be checked and were withheld." : "Approved, current knowledge only. Items awaiting review are not used.", records);
  return { outcome: { ok: true, records, report }, items, projectNames, withheld };
}

function recordOf(ctx: BrainChatContext, i: KnowledgeItem): RetrievedRecord {
  const ref = safeRef(i.id);
  return {
    source: "knowledge", type: "knowledge_item", ref, href: HREF, label: clean(i.title, 160), timestamp: i.reviewed_at, scope: "organization", provenance: provenanceOf(ctx),
    flagged: scanForInjection(i.title, i.body).suspected,
    attrs: {
      knowledge: {
        kind: i.kind, topic: i.topic, excerpt: clean(i.body, 2000), project_id: i.project_id, reviewed_at: i.reviewed_at, reviewer: i.reviewer_name ? clean(i.reviewer_name, 60) : null,
        source_note: i.source_ref ? clean(i.source_ref, 120) : null, stale: isStale(i, ctx.now), expires_at: i.expires_at,
      },
    },
  };
}

/** The knowledge source as a registry-style adapter (same contract as the task, notification and integration adapters). */
export const knowledgeAdapter: SourceAdapter = {
  id: "knowledge",
  async retrieve(ctx) { return (await loadKnowledge(ctx)).outcome; },
};

const approvalNote = (i: KnowledgeItem) =>
  [i.reviewer_name ? `approved by ${clean(i.reviewer_name, 60)}` : "approved", i.reviewed_at ? i.reviewed_at.slice(0, 10) : null, i.source_ref ? `source: ${clean(i.source_ref, 80)}` : null].filter(Boolean).join(", ");

function chatItem(ctx: BrainChatContext, i: KnowledgeItem, names: Map<string, string>): ChatItem {
  const project = i.project_id ? names.get(i.project_id) : null;
  const stale = isStale(i, ctx.now) ? ` Not reviewed for ${ageInDays(i.reviewed_at ?? i.created_at, ctx.now)} days; it may be out of date.` : "";
  return {
    text: `${KIND_LABEL[i.kind]}${project ? ` (${clean(project, 80)})` : ""}: ${clean(i.title, 160)}. ${clean(i.body, EXCERPT)} [${approvalNote(i)}]${stale}`,
    source: "knowledge", href: HREF, as_of: i.reviewed_at ?? i.created_at, ...(scanForInjection(i.title, i.body).suspected ? { flagged: true } : {}),
  };
}

function conflictSections(ctx: BrainChatContext, shown: KnowledgeItem[], all: KnowledgeItem[], names: Map<string, string>): ChatSection[] {
  const ids = new Set(shown.map((i) => i.id));
  return conflictGroups(all, ctx.now).filter((g) => g.some((i) => ids.has(i.id))).map((g): ChatSection => ({
    kind: "derived", heading: `Conflicting approved knowledge: ${g[0].topic}`,
    text: "These current items share a topic but say different things. I have not chosen one. An administrator should supersede or expire the outdated item.",
    items: g.map((i) => chatItem(ctx, i, names)),
  }));
}

const noRecords = (ctx: BrainChatContext, items: KnowledgeItem[]) => items.map((i) => recordOf(ctx, i));

export async function answerKnowledge(ctx: BrainChatContext, message: string, opts: { explicit: boolean; projectId?: string }): Promise<ChatReply | null> {
  const loaded = await loadKnowledgeViaTools(ctx);
  const { outcome } = loaded;
  if (!outcome.ok) {
    // A plain question that merely fell through to "unsupported" must behave exactly as before when knowledge is unavailable.
    if (!opts.explicit) return null;
    const text = outcome.report.reason === "not_connected"
      ? "Organizational knowledge is not connected in this environment, so I have nothing to search. Nothing was substituted."
      : "I could not read organizational knowledge right now, so I can't answer from it. Nothing was substituted.";
    return finish(ctx, { intent: "knowledge", text, sources: [outcome.report] });
  }
  let items = loaded.items;
  if (opts.projectId) items = items.filter((i) => i.scope === "organization" || i.project_id === opts.projectId);
  let matches = searchKnowledge(items, message, MAX_SHOWN);
  // A question that names only a KIND ("our approved procedure", "what did we decide") has no content words to match. Offer the most recently
  // approved items of that kind instead of a false "nothing found". The same eligibility rules already applied to `items`.
  const kinds = kindHints(message);
  if (matches.length === 0 && significantTerms(message).length === 0 && kinds.length > 0) {
    matches = items.filter((i) => kinds.includes(i.kind)).sort((a, b) => (b.reviewed_at ?? "").localeCompare(a.reviewed_at ?? "") || a.id.localeCompare(b.id)).slice(0, MAX_SHOWN).map((item) => ({ item, score: 0, matched: 0 }));
  }
  if (matches.length === 0) {
    if (!opts.explicit) return null;
    return finish(ctx, {
      intent: "knowledge", sources: [outcome.report],
      text: `I found no approved organizational knowledge that matches this. Only approved, current knowledge is searched; submissions awaiting review are never used.${loaded.withheld ? " Some project notes could not be checked and were withheld." : ""}`,
    });
  }
  const shown = matches.map((m) => m.item);
  const conflicts = conflictSections(ctx, shown, items, loaded.projectNames);
  const staleShown = shown.filter((i) => isStale(i, ctx.now));
  const report: SourceReport = { ...outcome.report, count: shown.length, ...(staleShown.length ? { state: "stale" as const, detail: `Approved knowledge. ${staleShown.length} matching item(s) have not been reviewed for over ${STALE_AFTER_DAYS} days.` } : {}) };
  const text =
    `I found ${shown.length} approved knowledge item${shown.length === 1 ? "" : "s"} that may answer this. Only approved, current knowledge is used; items awaiting review are ignored.`
    + (conflicts.length ? " Some of it conflicts, as shown below." : "")
    + (staleShown.length ? ` ${staleShown.length === 1 ? "One item has" : `${staleShown.length} items have`} not been reviewed for over ${STALE_AFTER_DAYS} days.` : "");
  return finish(ctx, {
    intent: "knowledge", text, sources: [report], used: noRecords(ctx, shown), evidence: true,
    sections: [{ kind: "facts", heading: `Approved knowledge (${shown.length})`, items: shown.map((i) => chatItem(ctx, i, loaded.projectNames)) }, ...conflicts],
  });
}

/**
 * Decides whether a question is for organizational knowledge, and answers it. Returns null when it is not (the normal Brain flow
 * then continues unchanged). Explicit knowledge questions always get an answer, including an honest "nothing found" or
 * "unavailable"; a question that is otherwise unsupported is answered from knowledge only when approved knowledge really matches.
 */
export async function tryKnowledge(ctx: BrainChatContext, message: string, routed: RoutedIntent, projectId: string | undefined): Promise<ChatReply | null> {
  if (routed.parts.length > 0 || routed.domains.length > 0) return null;
  const explicit = KNOWLEDGE_TRIGGER.test(message);
  if (!explicit && routed.intent !== "unsupported") return null;
  if (!ctx.repo.knowledge && !explicit) return null;
  try {
    return await answerKnowledge(ctx, message, { explicit, projectId });
  } catch (e) {
    console.error("[chat] knowledge", e);
    return explicit ? finish(ctx, { intent: "knowledge", text: "I could not read organizational knowledge right now, so I can't answer from it. Nothing was substituted.", sources: [failed("knowledge").report] }) : null;
  }
}

/**
 * Adds the approved notes for ONE project to a Pre-Construction answer scoped to that project. The Pre-Construction answer itself is
 * never changed; if knowledge is unavailable the answer is returned as it was, with an honest note that it was not checked.
 */
export async function withProjectKnowledge(ctx: BrainChatContext, reply: ChatReply, project: PreconProject): Promise<ChatReply> {
  if (!ctx.repo.knowledge) return reply;
  try {
    const loaded = await loadKnowledgeViaTools(ctx);
    if (!loaded.outcome.ok) {
      const report = loaded.outcome.report;
      return { ...reply, sources: [...reply.sources, report], grounding: { ...reply.grounding, not_covered: [...reply.grounding.not_covered, "knowledge"] },
        sections: [...reply.sections, { kind: "missing", heading: "Not checked", text: `${LABELS.knowledge}: ${report.detail}` }] };
    }
    const notes = loaded.items.filter((i) => i.scope === "project" && i.project_id === project.id).sort((a, b) => (b.reviewed_at ?? "").localeCompare(a.reviewed_at ?? "")).slice(0, MAX_SHOWN);
    if (notes.length === 0) return reply;
    const section: ChatSection = {
      kind: "facts", heading: `Approved notes for this project (${notes.length})`,
      text: "Written by people and approved by an administrator; not read from the documents above.",
      items: notes.map((i) => chatItem(ctx, i, loaded.projectNames)),
    };
    const report: SourceReport = { ...loaded.outcome.report, count: notes.length };
    return {
      ...reply, sections: [...reply.sections, section], sources: [...reply.sources, report],
      grounding: { ...reply.grounding, facts: reply.grounding.facts + notes.length, evidence: true, sources_used: [...new Set([...reply.grounding.sources_used, "knowledge" as const])] },
    };
  } catch (e) {
    console.error("[chat] project knowledge", e);
    return reply;
  }
}
