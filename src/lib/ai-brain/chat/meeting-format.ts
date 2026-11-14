import { formatDate, formatTime, localParts } from "../assistant/meetings/datetime";
import { gapSentence, type MeetingView, type ViewAction, type ViewItem } from "../assistant/meetings/analysis";
import type { MeetingRequest } from "../assistant/meetings/request";
import type { Coverage, CoverageGap, MeetingDocument } from "../assistant/meetings/types";
import type { ChatItem, ChatSection } from "./types";

/** Turns a validated or structure-derived meeting view into chat sections. Plain text only; the one link is the source page. */

const NONE_MODEL = "None recorded in the page.";
const NONE_STRUCTURE = "None found under a matching heading in the page.";

/** "23 October 2026, 1:00 PM" in the zone the question was read in, or just the date when the source records no time of day. */
export function whenText(doc: Pick<MeetingDocument, "starts_at" | "date_only">, tz: string): string | null {
  if (!doc.starts_at) return null;
  if (doc.date_only) {
    const [y, m, d] = doc.starts_at.split("-").map(Number);
    return formatDate({ year: y, month: m, day: d });
  }
  const p = localParts(Date.parse(doc.starts_at), tz);
  return `${formatDate(p)}, ${formatTime(p)}`;
}

const items = (xs: ViewItem[], empty: string): ChatItem[] =>
  xs.length === 0 ? [{ text: empty }] : xs.map((x) => ({ text: x.text, source: "documents", cite: x.cite }));
const actionItems = (xs: ViewAction[], empty: string): ChatItem[] =>
  xs.length === 0
    ? [{ text: empty }]
    : xs.map((a) => ({ text: `${a.task} — Owner: ${a.owner ?? "not recorded"} — Deadline: ${a.deadline ?? "not recorded"}`, source: "documents" as const, cite: a.cite }));

export function coverageSection(c: Coverage, extra: CoverageGap[] = []): ChatSection {
  const gaps = [...new Set([...c.gaps, ...extra])];
  return c.complete && extra.length === 0
    ? { kind: "facts", heading: "Content coverage", text: `Complete: all ${c.blocks_read} blocks of the page, including nested content, were read.` }
    : { kind: "missing", heading: "Content coverage", text: `Partial: ${gapSentence(gaps)}. ${c.blocks_read} blocks were read; anything after that point is not reflected below.` };
}

export interface FormatInput {
  doc: MeetingDocument;
  req: MeetingRequest;
  view: MeetingView;
  extraGaps: CoverageGap[];
  notes: string[];
  now: Date;
}

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
const cap1 = (t: string) => t.charAt(0).toUpperCase() + t.slice(1);
const TIMESTAMP_TITLE = /^meeting\s+\d{4}-\d{2}-\d{2}/i;

/** "yesterday's meeting", "today's meeting", or "the meeting on 29 October": how a person would refer to it. */
export function meetingLabel(doc: Pick<MeetingDocument, "starts_at" | "date_only" | "title">, tz: string, now: Date, withTime = false): string {
  if (!doc.starts_at) return TIMESTAMP_TITLE.test(doc.title) ? "the meeting" : `the meeting "${doc.title}"`;
  const local = doc.date_only ? (() => { const [y, m, d] = doc.starts_at!.split("-").map(Number); return { year: y, month: m, day: d }; })() : localParts(Date.parse(doc.starts_at), tz);
  const today = localParts(now.getTime(), tz);
  const same = (a: { year: number; month: number; day: number }, b: { year: number; month: number; day: number }) => a.year === b.year && a.month === b.month && a.day === b.day;
  const yest = (() => { const d = new Date(Date.UTC(today.year, today.month - 1, today.day - 1)); return { year: d.getUTCFullYear(), month: d.getUTCMonth() + 1, day: d.getUTCDate() }; })();
  if (same(local, today)) return "today's meeting";
  if (same(local, yest)) return "yesterday's meeting";
  const named = TIMESTAMP_TITLE.test(doc.title) ? "" : ` "${doc.title}"`;
  const month = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"][local.month - 1];
  return `the${named} meeting on ${local.day} ${month}${withTime && !doc.date_only ? ` at ${formatTime(localParts(Date.parse(doc.starts_at!), tz))}` : ""}`;
}

const sentence = (t: string): string => (/[.!?]$/.test(t.trim()) ? t.trim() : `${t.trim()}.`);

/** The first thing the user reads: a short, natural answer to what they asked. The sections below it are the detail. */
export function narrative({ doc, req, view, now }: Pick<FormatInput, "doc" | "req" | "view" | "now">): string {
  const label = meetingLabel(doc, req.tz, now, !!req.time);
  const model = view.source === "model";
  const owned = view.actions.filter((a) => a.owner);
  const dated = view.actions.filter((a) => a.deadline);
  const decisions = plural(view.decisions.length, "decision");
  const decisionLine = view.decisions.length > 0 ? `${cap1(decisions)} ${view.decisions.length === 1 ? "was" : "were"} recorded.` : "No decision was explicitly recorded.";
  const actionLine = view.actions.length === 0
    ? "No action items were recorded."
    : `${cap1(plural(view.actions.length, "action item"))}: ${owned.length === 0 ? "none has a named owner" : owned.length === view.actions.length ? "all have a named owner" : `${owned.length} with a named owner`}${dated.length > 0 ? `, ${dated.length} with a deadline` : ""}.`;

  if (req.brief) {
    const lead = view.overview ? sentence(view.overview.text) : `Here is ${label}.`;
    return `${lead} ${decisionLine} ${actionLine}`.slice(0, 700);
  }
  if (req.narrow === "owners") {
    if (view.actions.length === 0) return `No action items were recorded in ${label}, so nobody is named as responsible.`;
    if (owned.length === 0) return `${cap1(label)} has ${plural(view.actions.length, "action item")}, but the notes do not name an owner for any of them.`;
    const first = owned[0]!;
    const rest = view.actions.length - owned.length;
    const lead = owned.length === 1 ? `The notes name ${first.owner} as responsible for "${first.task}".` : `The notes name an owner for ${owned.length} of the ${view.actions.length} action items in ${label}.`;
    return `${lead}${rest > 0 ? ` No owner was assigned to the other ${rest === 1 ? "item" : `${rest} items`}.` : ""}`;
  }
  if (req.narrow === "pending") {
    const open = view.actions.length, q = view.questions.length;
    if (open === 0 && q === 0) return `Nothing is recorded as open from ${label}. The notes do not track whether items were completed afterwards.`;
    return `Still open from ${label}: ${[open > 0 ? plural(open, "action item") : "", q > 0 ? plural(q, "unresolved question") : ""].filter(Boolean).join(" and ")}. The notes do not track whether they were completed afterwards.`;
  }
  if (req.output === "decisions") {
    const suggested = view.inferred_decisions.length;
    const tail = suggested > 0 ? ` ${cap1(plural(suggested, "other outcome"))} ${suggested === 1 ? "was" : "were"} suggested but not confirmed.` : "";
    return `${decisionLine.replace("recorded.", `recorded in ${label}.`)}${tail}${model ? "" : " (This is read from the page's own structure; no AI summary was available.)"}`;
  }
  if (req.output === "action_items") {
    return view.actions.length === 0 ? `No action items were recorded in ${label}.` : `${cap1(label)} has ${plural(view.actions.length, "action item")}. ${actionLine.replace(/^\d+ action items?: /, "").replace(/^./, (c) => c.toUpperCase())}`;
  }
  if (!model) return `Here is ${label} as written on the page. No AI summary was available, so nothing below is rewritten.`;
  const lead = view.overview ? sentence(view.overview.text) : "";
  return `Here is what ${label} covered. ${lead} ${decisionLine} ${actionLine}`.replace(/\s+/g, " ").trim();
}

export function formatMeeting({ doc, req, view, extraGaps, notes, now }: FormatInput): { text: string; sections: ChatSection[] } {
  const model = view.source === "model";
  const none = model ? NONE_MODEL : NONE_STRUCTURE;
  const text = narrative({ doc, req, view, now });
  const sections: ChatSection[] = [];
  const wantDecisions = req.output !== "action_items" && !req.narrow;
  const wantActions = req.output !== "decisions" || req.narrow !== undefined;
  const wantSummary = (req.output === "summary" || req.output === "all") && !req.narrow;

  if (!req.brief) {
    if (wantSummary) {
      if (view.discussion.length > 0 || model) sections.push({ kind: "facts", heading: "Key discussion points", items: items(view.discussion, NONE_MODEL) });
    }
    if (wantDecisions) {
      sections.push({ kind: "facts", heading: "Decisions", items: items(view.decisions, none) });
      if (view.inferred_decisions.length > 0) sections.push({ kind: "derived", heading: "Suggested, not confirmed as decisions", items: items(view.inferred_decisions, "") });
    }
    if (wantActions) {
      sections.push({ kind: "facts", heading: "Action items, owners and deadlines", items: actionItems(view.actions, none) });
      if (req.output !== "summary" && !req.narrow && view.follow_ups.length > 0) sections.push({ kind: "facts", heading: "Follow-ups", items: items(view.follow_ups, "") });
    }
    if (wantSummary || req.narrow === "pending") {
      if (view.questions.length > 0 || (model && req.narrow !== "pending")) sections.push({ kind: "facts", heading: "Open questions", items: items(view.questions, NONE_MODEL) });
    }
    if (wantSummary) {
      if (view.risks.length > 0) sections.push({ kind: "facts", heading: "Risks", items: items(view.risks, "") });
      if (view.follow_ups.length > 0) sections.push({ kind: "facts", heading: "Follow-ups", items: items(view.follow_ups, "") });
    }
  }

  // Only what changes how far the answer can be trusted. Retrieval timestamps and block counts are not part of a normal answer.
  const gaps = [...new Set([...doc.coverage.gaps, ...extraGaps])];
  const limits = [
    ...view.limitations,
    ...(view.confidence === "low" ? ["The AI rated its own confidence in this analysis as low."] : []),
    ...(!doc.coverage.complete || extraGaps.length > 0 ? [`Only part of the page could be read: ${gapSentence(gaps)}.`] : []),
    ...notes,
  ];
  if (limits.length > 0 && !req.brief) sections.push({ kind: "derived", heading: "Good to know", items: limits.map((t) => ({ text: t })) });

  sections.push({ kind: "facts", heading: "Source", items: [{ text: doc.title, source: "documents", ...(doc.url ? { external_url: doc.url } : {}) }] });
  return { text, sections };
}

/** The page text as written (for "show me the content"), flagged passages marked and never interpreted. */
export function contentSections(doc: MeetingDocument): ChatSection[] {
  const body = doc.segments.filter((s) => s.kind !== "title" && s.kind !== "property");
  const shown = body.slice(0, 40);
  const sections: ChatSection[] = [{
    kind: "facts", heading: `Page content, as written (${shown.length}${body.length > shown.length ? ` of ${body.length}` : ""} passages)`,
    items: shown.map((s) => ({ text: s.text, source: "documents" as const, cite: [s.id], ...(s.flagged ? { flagged: true } : {}) })),
  }];
  return sections;
}
