import { runBrainTool } from "../assistant/brain-tools";
import type { MeetingView } from "../assistant/meetings/analysis";
import { localParts } from "../assistant/meetings/datetime";
import { termsOf, type MeetingRequest } from "../assistant/meetings/request";
import type { MeetingCandidate, MeetingDocument, SourceSegment } from "../assistant/meetings/types";
import { finish } from "./brain";
import { whenText } from "./meeting-format";
import type { BrainChatContext, ChatReply, ChatSection, RetrievedRecord, SourceReport } from "./types";

/**
 * Questions that span meetings: "what did we agree about the marketplace?", "was this discussed last week?", "has that decision changed?".
 *
 * Deterministic by design. The meetings are read through the same authorized tool, and the answer is built only from passages that are
 * actually in them, quoted and linked, with what was RECORDED AS AGREED kept apart from what was only mentioned. No model writes this answer,
 * so nothing can be invented; when the notes do not say, it says so.
 */

const MAX_MEETINGS = 6;
const MAX_PASSAGES = 3;
const AGREED_HEADING = /decision|agreed|outcome|resolution/i;
const AGREED_TEXT = /\b(decided|agreed|approved|confirmed|settled|signed off|going ahead|will go with|we will|we'll)\b/i;
const MEETINGISH = /meeting|sync|stand-?up|call|minutes|catch-?up|review|discussion|retro|planning/i;

/** What a meeting was about, as a few words: the commonest content words of its overview, decisions and first discussion points. Search terms only. */
// Words that describe any meeting rather than what this one was about; never useful as search terms.
const GENERIC = new Set(["business", "company", "recording", "recorded", "transcript", "mixed", "including", "related", "various", "general", "future", "current", "specific", "discussion", "discussions", "about", "covers", "covered", "large", "parts", "early", "possible", "several", "around", "between", "through", "their", "there", "which", "would", "should", "could", "being", "after", "before", "while", "other", "offers", "plans", "planning", "concept", "ideas", "idea"]);

export function topicsOf(view: MeetingView): string[] {
  const texts = [view.overview?.text, ...view.decisions.map((d) => d.text), ...view.discussion.slice(0, 4).map((d) => d.text)].filter((t): t is string => !!t);
  const count = new Map<string, number>();
  for (const t of texts) for (const w of termsOf(t)) if (w.length >= 5 && !GENERIC.has(w)) count.set(w, (count.get(w) ?? 0) + 1);
  return [...count.entries()].sort((a, b) => b[1] - a[1]).slice(0, 4).map(([w]) => w);
}

const stemOf = (term: string): string => term.slice(0, Math.max(4, term.length - 2));

export interface Passages { agreed: string[]; mentioned: string[] }

/** The passages of one meeting that mention the topic. Pure. */
export function passagesFor(segments: SourceSegment[], terms: string[]): Passages {
  const stems = terms.map(stemOf);
  // A passage counts when it contains the main term, or at least two of the terms: one generic word alone ("model", "plan") is not the topic.
  const matches = (lower: string): boolean => stems.length <= 1 ? stems.some((st) => lower.includes(st)) : lower.includes(stems[0]!) || stems.filter((st) => lower.includes(st)).length >= 2;
  const out: Passages = { agreed: [], mentioned: [] };
  let inDecisions = false;
  for (const s of segments) {
    if (s.kind === "heading" || s.kind === "subpage") { inDecisions = AGREED_HEADING.test(s.text); continue; }
    if (s.kind === "title" || s.kind === "property" || s.flagged) continue;
    const lower = s.text.toLowerCase();
    if (!matches(lower)) continue;
    const text = s.text.length > 240 ? `${s.text.slice(0, 237)}...` : s.text;
    if (inDecisions || AGREED_TEXT.test(s.text)) { if (out.agreed.length < MAX_PASSAGES) out.agreed.push(text); }
    else if (out.mentioned.length < MAX_PASSAGES) out.mentioned.push(text);
  }
  return out;
}

const localDay = (c: MeetingCandidate, tz: string): string | null => {
  if (!c.starts_at) return null;
  if (c.date_only) return c.starts_at;
  const p = localParts(Date.parse(c.starts_at), tz);
  return `${p.year}-${String(p.month).padStart(2, "0")}-${String(p.day).padStart(2, "0")}`;
};
const ms = (c: Pick<MeetingCandidate, "starts_at">): number => (c.starts_at ? Date.parse(c.starts_at) : NaN);

/** Which meetings to look in. Pure. */
export function topicPool(all: MeetingCandidate[], req: MeetingRequest, now: Date, focus: BrainChatContext["focus"]): MeetingCandidate[] {
  const topic = req.topic!;
  let pool = all.filter((c) => c.starts_at && (MEETINGISH.test(c.title) || c.date_source === "date_property") && ms(c) <= now.getTime());
  if (topic.when === "window" && req.window) {
    pool = pool.filter((c) => { const d = localDay(c, req.tz); return !!d && d >= req.window!.from && d <= req.window!.to; });
    if (focus) pool = pool.filter((c) => c.record_id !== focus.id);
    return pool.sort((a, b) => ms(b) - ms(a)).slice(0, MAX_MEETINGS);
  }
  if (topic.when === "later" && focus?.starts_at) {
    const after = Date.parse(focus.starts_at);
    pool = pool.filter((c) => c.record_id !== focus.id && ms(c) > after);
    return pool.sort((a, b) => ms(a) - ms(b)).slice(0, MAX_MEETINGS);
  }
  return pool.sort((a, b) => ms(b) - ms(a)).slice(0, MAX_MEETINGS);
}

const windowName = (req: MeetingRequest): string => req.window?.label ?? "in the meetings I can see";

export async function answerTopic(ctx: BrainChatContext, req: MeetingRequest, all: MeetingCandidate[], searched: SourceReport, read: string): Promise<ChatReply> {
  const topic = req.topic!;
  const pool = topicPool(all, req, ctx.now, ctx.focus);
  const name = topic.derived ? `the topic of that meeting (${topic.terms.slice(0, 2).join(", ")})` : topic.terms.slice(0, 3).join(" ");
  const Name = name.charAt(0).toUpperCase() + name.slice(1);
  const quietExtra = { follow_ups: [] as string[], generation: "rules" as const, quiet: true as const };
  const where = topic.when === "later" ? "after that" : windowName(req);

  if (pool.length === 0) {
    const text = topic.when === "later"
      ? "There are no later meetings in Notion to compare against, so I cannot say whether anything changed."
      : topic.when === "window" ? `I can't see any meeting notes from ${windowName(req)}, so I cannot tell whether it came up.` : "I could not find meeting notes to look through.";
    return finish(ctx, { intent: "knowledge", text, sources: [searched], evidence: false, extra: quietExtra });
  }

  const reads = await Promise.all(pool.map((c) => runBrainTool(ctx, read, { id: c.record_id })));
  const docs: MeetingDocument[] = [];
  let failed = 0;
  for (const r of reads) {
    const d = r.ok ? (r.native as MeetingDocument | undefined) : undefined;
    if (d && Array.isArray(d.segments)) docs.push(d); else failed += 1;
  }
  if (docs.length === 0) {
    return finish(ctx, { intent: "knowledge", text: "I found the meetings but could not read them just now. Nothing was substituted. Please try again in a moment.", sources: [{ ...searched, state: "unavailable", reason: "error", detail: "The meeting pages could not be read." }], extra: quietExtra });
  }

  const hits = docs.map((d) => ({ doc: d, p: passagesFor(d.segments, topic.terms) })).filter((h) => h.p.agreed.length + h.p.mentioned.length > 0);
  const agreedMeetings = hits.filter((h) => h.p.agreed.length > 0).length;
  const sections: ChatSection[] = [];
  const itemOf = (doc: MeetingDocument, t: string) => ({ text: t, source: "documents" as const, ...(doc.url ? { external_url: doc.url } : {}) });
  for (const h of hits) {
    const when = whenText(h.doc, req.tz) ?? h.doc.title;
    if (h.p.agreed.length > 0) sections.push({ kind: "facts", heading: `${when}: recorded as agreed`, items: h.p.agreed.map((t) => itemOf(h.doc, t)) });
    if (h.p.mentioned.length > 0) sections.push({ kind: "facts", heading: `${when}: discussed, not recorded as a decision`, items: h.p.mentioned.map((t) => itemOf(h.doc, t)) });
  }
  const n = hits.length;
  const meetings = `${n} meeting${n === 1 ? "" : "s"}`;
  let text: string;
  if (n === 0) {
    text = topic.when === "later"
      ? `I found no later mention of ${name} in the meeting notes, so as far as they show, nothing has changed. I can only go by what was written down.`
      : topic.asks === "agreed"
        ? `I did not find ${name} in the meeting notes I could read, so I can't say what was agreed. Nothing was invented.`
        : `No. I did not find ${name} in the meeting notes ${where}.`;
  } else if (topic.when === "later") {
    text = agreedMeetings > 0
      ? `${Name} was raised again in ${meetings} afterwards, and ${agreedMeetings === 1 ? "one records" : "some record"} an agreement on it, so the earlier decision may have been updated. The passages are below; the notes do not say outright that it changed.`
      : `${Name} came up again in ${meetings} afterwards, but none records a new decision on it. Compare the passages below with the earlier decision.`;
  } else if (topic.asks === "agreed") {
    text = agreedMeetings > 0
      ? `On ${name}, the notes record agreement in ${agreedMeetings} meeting${agreedMeetings === 1 ? "" : "s"}. Anything that was only discussed is listed separately, because a discussion is not a decision.`
      : `${Name} came up in ${meetings}, but the notes do not record it as agreed. It was discussed, not decided.`;
  } else {
    text = `Yes. ${Name} came up in ${meetings} ${where === "in the meetings I can see" ? "so far" : where}.${agreedMeetings > 0 ? " At least one meeting records an agreement on it." : ""}`;
  }
  if (failed > 0) sections.push({ kind: "missing", heading: "Good to know", text: `${failed} meeting${failed === 1 ? "" : "s"} could not be read just now, so this may be incomplete.` });
  if (docs.some((d) => !d.coverage.complete)) sections.push({ kind: "missing", heading: "Good to know", text: "Some long meeting pages were only partly read." });

  const used: RetrievedRecord[] = docs.map((d) => ({
    source: "documents", type: "external_page", ref: /^[A-Za-z0-9_-]{1,64}$/.test(d.record_id) ? d.record_id : null, label: d.title, timestamp: d.retrieved_at,
    scope: "organization", provenance: "live", flagged: false, attrs: {},
  }));
  return finish(ctx, { intent: "knowledge", text, sections, sources: [searched], used, evidence: n > 0, extra: { ...quietExtra, ...(ctx.focus ? { focus: ctx.focus } : {}) } });
}
