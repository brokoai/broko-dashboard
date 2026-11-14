import { runBrainTool } from "../assistant/brain-tools";
import { buildPackage, deterministicView, MAX_OUTPUT_TOKENS, validateAnalysis, type MeetingView } from "../assistant/meetings/analysis";
import { clean } from "./retrieval";
import { formatDate, formatTime, isValidTimeZone, localParts } from "../assistant/meetings/datetime";
import { parseMeetingRequest, type MeetingRequest } from "../assistant/meetings/request";
import type { CoverageGap, MeetingCandidate, MeetingDocument } from "../assistant/meetings/types";
import type { ToolFailure } from "../assistant/tools";
import { finish } from "./brain";
import { cacheKey } from "./meeting-cache";
import { contentSections, formatMeeting, whenText } from "./meeting-format";
import { answerTopic, topicsOf } from "./meeting-topics";
import { REASON } from "./notion";
import type { RoutedIntent } from "./intent";
import type { BrainChatContext, ChatFocus, ChatReply, RetrievedRecord, SourceReport } from "./types";

/**
 * Meeting intelligence: a natural-language question about a meeting is understood, the meeting is located in the connected source,
 * its full content is read through the tool registry, analysed by the model (when there is one) and VALIDATED against that content, and
 * answered in the existing chat. Every stage is a separate function here or in `assistant/meetings/`:
 *
 *   understand (request.ts) → authorize → find (tool) → select (here) → read (tool) → analyse + validate (analysis.ts) → format (meeting-format.ts)
 *
 * Notion is the first provider; a new source adds an entry to PROVIDERS and a connector, and nothing else here changes.
 * Read-only throughout: nothing is written to Notion, to Broko's database, or to Knowledge.
 */

interface Provider { system: "notion"; find: string; read: string; label: string }
const PROVIDERS: readonly Provider[] = [{ system: "notion", find: "notion.meetings.find", read: "notion.meetings.read", label: "Notion (pages shared with Broko)" }];
const PROVIDER = PROVIDERS[0]!;

const TIMESTAMP_TITLE = /^meeting\s+\d{4}-\d{2}-\d{2}/i;
const MEETINGISH = /meeting|sync|stand-?up|call|minutes|catch-?up|review|discussion|retro|planning/i;
const TIME_TOLERANCE_MIN = 29;
const MAX_OPTIONS = 5;

const MESSAGE_DOMAINS: string[] = ["email", "teams", "whatsapp"];

const report = (state: SourceReport["state"], detail: string, extra: Partial<SourceReport> = {}): SourceReport => ({ id: "documents", label: PROVIDER.label, state, detail, ...extra });
const unavailable = (ctx: BrainChatContext, text: string, why: Pick<SourceReport, "reason" | "detail">): ChatReply =>
  finish(ctx, { intent: "knowledge", text, sources: [report("unavailable", why.detail, { reason: why.reason })], extra: { follow_ups: [], generation: "rules" } });

// ---- select ----------------------------------------------------------------------------------------------------------------

export interface Selection { matches: MeetingCandidate[]; time_unverified: boolean }

const norm = (s: string) => s.toLowerCase().replace(/\s+/g, " ").trim();

/** The candidates that fit the question. Pure and exact: date and time are compared in the question's own time zone, never by guesswork. */
export function selectMeetings(all: MeetingCandidate[], req: MeetingRequest, now: Date): Selection {
  let pool = all;
  if (req.exact_title) {
    const t = norm(req.exact_title);
    const exact = pool.filter((c) => norm(c.title) === t);
    pool = exact.length > 0 ? exact : pool.filter((c) => norm(c.title).includes(t));
  } else if (req.keywords.length > 0) {
    const narrowed = pool.filter((c) => { const t = norm(c.title); return req.keywords.every((k) => t.includes(k)); });
    // Words that are left over after dates and common words are only HINTS when the question names a date: titles are often just
    // "Meeting <date>", so a stray word ("came", "out") must not hide the meeting the date already identifies. With no date they stay strict.
    pool = narrowed.length > 0 || !req.date ? narrowed : pool;
  } else {
    pool = pool.filter((c) => MEETINGISH.test(c.title) || c.date_source === "date_property");
  }
  let timeUnverified = false;
  if (req.date) {
    const d = req.date;
    pool = pool.filter((c) => {
      if (!c.starts_at) return false;
      if (c.date_only) {
        const [y, m, day] = c.starts_at.split("-").map(Number);
        return m === d.month && day === d.day && (d.year === undefined || y === d.year);
      }
      const p = localParts(Date.parse(c.starts_at), req.tz);
      return p.month === d.month && p.day === d.day && (d.year === undefined || p.year === d.year);
    });
  }
  if (req.window) {
    const w = req.window;
    pool = pool.filter((c) => {
      if (!c.starts_at) return false;
      let day = c.starts_at;
      if (!c.date_only) { const p = localParts(Date.parse(c.starts_at), req.tz); day = `${p.year}-${String(p.month).padStart(2, "0")}-${String(p.day).padStart(2, "0")}`; }
      return day >= w.from && day <= w.to;
    });
  }
  if (req.time) {
    const t = req.time;
    pool = pool.filter((c) => {
      if (!c.starts_at) return false;
      if (c.date_only) { timeUnverified = true; return true; }
      const p = localParts(Date.parse(c.starts_at), req.tz);
      return Math.abs(p.hour * 60 + p.minute - (t.hour * 60 + t.minute)) <= TIME_TOLERANCE_MIN;
    });
    // Several meetings within the tolerance, but exactly one at the time that was asked for (within 2 minutes): that is the one meant.
    if (pool.length > 1) {
      const exact = pool.filter((c) => { if (c.date_only || !c.starts_at) return false; const p = localParts(Date.parse(c.starts_at), req.tz); return Math.abs(p.hour * 60 + p.minute - (t.hour * 60 + t.minute)) <= 2; });
      if (exact.length === 1) pool = exact;
    }
  }
  if (!req.date && !req.window && (req.latest || (req.keywords.length === 0 && !req.exact_title))) {
    const past = pool.filter((c) => c.starts_at && (c.date_only ? c.starts_at <= now.toISOString().slice(0, 10) : Date.parse(c.starts_at) <= now.getTime()));
    past.sort((a, b) => (b.starts_at ?? "").localeCompare(a.starts_at ?? ""));
    pool = past.slice(0, 1);
  }
  pool = [...pool].sort((a, b) => (b.starts_at ?? "").localeCompare(a.starts_at ?? ""));
  return { matches: pool, time_unverified: timeUnverified };
}

// ---- reply pieces ----------------------------------------------------------------------------------------------------------

const safeTitle = (t: string) => (/^[A-Za-z0-9 &'.,:@()/-]{1,80}$/.test(t) && !t.includes('"') ? t : null);

/** Options that, when clicked, re-ask the same question about exactly one meeting: the quoted title plus its own date and time. */
function optionsFor(matches: MeetingCandidate[], req: MeetingRequest): string[] {
  const lead = req.output === "decisions" ? "What were the decisions in the meeting" : req.output === "action_items" ? "Extract the action items from the meeting" : "Summarize the meeting";
  const out: string[] = [];
  for (const c of matches.slice(0, MAX_OPTIONS)) {
    if (!c.starts_at) continue;
    // A title that is just a timestamp adds nothing; the date and time identify the meeting on their own.
    const title = TIMESTAMP_TITLE.test(c.title) ? "" : safeTitle(c.title);
    if (title === null) continue;
    const zone = req.tz_explicit ? ` ${req.tz}` : "";
    const when = c.date_only
      ? (() => { const [y, m, d] = c.starts_at!.split("-").map(Number); return ` on ${formatDate({ year: y, month: m, day: d })}`; })()
      : (() => { const p = localParts(Date.parse(c.starts_at!), req.tz); return ` on ${formatDate(p)} at ${formatTime(p)}${zone}`; })();
    out.push(`${lead}${title ? ` "${title}"` : ""}${when}`);
  }
  return out;
}

/** Only present when there is something to say: an explicit `notice: undefined` would erase the demo-mode notice. */
const noticeOf = (notes: string[]): { notice?: string } => (notes.length > 0 ? { notice: notes.join(" ") } : {});

const MONTH_NAMES = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];

/** What was asked for, in plain words, for "I could not find a meeting ...". */
const describe = (req: MeetingRequest): string => {
  const parts: string[] = [];
  if (req.exact_title) parts.push(`called "${req.exact_title}"`);
  else if (req.keywords.length > 0) parts.push(`about ${req.keywords.join(" ")}`);
  if (req.date) parts.push(`on ${req.date.day} ${MONTH_NAMES[req.date.month - 1]}${req.date.year ? ` ${req.date.year}` : ""}`);
  if (req.window) parts.push(`in that week`);
  if (req.time) parts.push(`around ${formatTime(req.time)}`);
  return parts.join(" ");
};

/** Short questions that make sense next, because the conversation now remembers which meeting is meant. */
function nextQuestions(output: MeetingRequest["output"]): string[] {
  const all = ["What decisions were made?", "Who owns the action items?", "What remains pending?", "Give me a short executive summary.", "What about the previous meeting?"];
  const skip = output === "decisions" ? "What decisions were made?" : output === "action_items" ? "Who owns the action items?" : "";
  return all.filter((q) => q !== skip).slice(0, 4);
}

/** The conversation's memory of the meeting just answered. Search terms and ids only, never content. */
function focusFor(doc: MeetingDocument, view: MeetingView, req: MeetingRequest): ChatFocus | null {
  if (!/^[A-Za-z0-9-]{8,64}$/.test(doc.record_id)) return null;
  return { kind: "meeting", id: doc.record_id, title: clean(doc.title, 120) || "Meeting", ...(doc.starts_at ? { starts_at: doc.starts_at } : {}), output: req.output, topics: topicsOf(view) };
}

const startMs = (c: Pick<MeetingCandidate, "starts_at">): number => (c.starts_at ? Date.parse(c.starts_at) : NaN);

/**
 * Follow-ups that point at the meeting already being discussed ("that one", "the previous meeting"). The id from the browser is only a hint:
 * the meeting must also appear in this request's fresh, authorized search, so a stale or forged id finds nothing.
 */
function pickByFocus(all: MeetingCandidate[], req: MeetingRequest, focus: ChatFocus, now: Date): Selection & { edge?: string } {
  const meetingish = all.filter((c) => c.starts_at && (MEETINGISH.test(c.title) || c.date_source === "date_property"));
  const here = all.find((c) => c.record_id === focus.id);
  if (req.target === "focus") return { matches: here ? [here] : [], time_unverified: false, ...(here ? {} : { edge: "I can no longer find that meeting in Notion. It may have been moved or unshared." }) };
  const at = here ? startMs(here) : focus.starts_at ? Date.parse(focus.starts_at) : NaN;
  if (Number.isNaN(at)) return { matches: [], time_unverified: false, edge: "I am not sure which meeting you are comparing against. Tell me its date." };
  const others = meetingish.filter((c) => c.record_id !== focus.id && !Number.isNaN(startMs(c)));
  if (req.target === "previous") {
    const before = others.filter((c) => startMs(c) < at).sort((a, b) => startMs(b) - startMs(a));
    return { matches: before.slice(0, 1), time_unverified: false, ...(before.length === 0 ? { edge: "That is the earliest meeting I can see in Notion, so there is nothing before it." } : {}) };
  }
  const after = others.filter((c) => startMs(c) > at && startMs(c) <= now.getTime()).sort((a, b) => startMs(a) - startMs(b));
  return { matches: after.slice(0, 1), time_unverified: false, ...(after.length === 0 ? { edge: "That is the most recent meeting I can see in Notion, so there is nothing after it." } : {}) };
}

// ---- entry point -----------------------------------------------------------------------------------------------------------

export async function tryMeeting(ctx: BrainChatContext, message: string, routed: RoutedIntent): Promise<ChatReply | null> {
  const tz = ctx.timeZone && isValidTimeZone(ctx.timeZone) ? ctx.timeZone : "UTC";
  const req = parseMeetingRequest(message, { now: ctx.now, tz, focus: ctx.focus });
  if (!req) return null;
  // A question about meetings in someone's email or chat is not a Notion question.
  if (routed.domains.some((d) => MESSAGE_DOMAINS.includes(d)) && !/\bnotion\b/i.test(message)) return null;

  // Authorization first, before any source is contacted. Notion access is workspace-wide (what was shared with Broko, not what each employee
  // could open), so employee-level authorization cannot be established: only administrators may use it, and members are told why.
  if (ctx.user.role !== "admin") {
    return unavailable(ctx,
      "Meeting notes are read from Notion, and Broko's Notion access covers everything shared with Broko, not what each person could open. Until per-person access exists, only administrators can ask about Notion meetings. Nothing was read.",
      { reason: "admin_only", detail: "Administrators only: Notion access is workspace-wide, not per employee." });
  }

  if (req.clarify) {
    return finish(ctx, { intent: "clarify", text: req.clarify, extra: { clarification: { question: req.clarify, options: [] }, follow_ups: [], generation: "rules" } });
  }

  // find
  const wide = !!req.target || !!req.topic;
  const found = await runBrainTool(ctx, PROVIDER.find, { keywords: wide ? [] : req.keywords, limit: 100 });
  if (!found.ok) {
    if (found.reason === "not_connected") return unavailable(ctx, "Meeting notes are read from Notion, which is not connected, so I could not look for the meeting.", REASON.not_connected);
    return unavailable(ctx, `I could not search Notion for the meeting: ${REASON[found.reason].detail} Nothing was substituted.`, REASON[found.reason]);
  }
  const candidates = Array.isArray(found.native) ? (found.native as MeetingCandidate[]) : [];
  const searched = report("live", "Connected to Notion. Searched the pages shared with Broko (titles, dates and links only).", { retrieved_at: found.retrieved_at });

  if (req.topic) return answerTopic(ctx, req, candidates, searched, PROVIDER.read);

  // select
  const sel: Selection & { edge?: string } = req.target && ctx.focus ? pickByFocus(candidates, req, ctx.focus, ctx.now) : selectMeetings(candidates, req, ctx.now);
  if (sel.matches.length === 0) {
    const wanted = describe(req);
    const text = sel.edge
      ? sel.edge
      : candidates.length === 0
        ? "Notion is connected, but no pages are shared with Broko yet, so there is no meeting to read. Share the meeting page with the Broko integration in Notion (page menu, Connections) and ask again."
        : `I couldn't find a meeting${wanted ? ` ${wanted}` : ""} in the notes shared with Broko. Nothing was invented.`;
    return finish(ctx, {
      intent: "knowledge", text, sources: [searched], evidence: false,
      sections: sel.edge ? [] : [{ kind: "missing", heading: "Good to know", text: `Dates and times were read in ${req.tz_label}${req.tz_explicit ? "" : " (your time zone)"}. If the meeting exists, it may not be shared with Broko, or its date may not be recorded on the page.` }],
      extra: { follow_ups: [], generation: "rules", quiet: true, ...(ctx.focus ? { focus: ctx.focus } : {}) },
    });
  }
  if (sel.matches.length > 1) {
    const options = optionsFor(sel.matches, req);
    const q = `I found ${sel.matches.length} meetings that match. Which one do you mean?`;
    return finish(ctx, {
      intent: "clarify", text: q, sources: [searched],
      sections: [{ kind: "facts", heading: "Matching meetings", items: sel.matches.slice(0, 8).map((c) => ({ text: TIMESTAMP_TITLE.test(c.title) && c.starts_at ? `Meeting, ${whenText(c, req.tz)}` : `${c.title}${c.starts_at ? `. ${whenText(c, req.tz)}` : ""}`, source: "documents" as const, ...(c.url ? { external_url: c.url } : {}) })) }],
      extra: { clarification: { question: q, options }, follow_ups: [], generation: "rules", quiet: true, ...(ctx.focus ? { focus: ctx.focus } : {}) },
    });
  }
  const chosen = sel.matches[0]!;

  // read and analyse, or reuse what was read and analysed a moment ago in this conversation
  const key = ctx.meetingCache && ctx.synthesizer ? cacheKey(ctx.user.id, chosen.record_id, chosen.last_edited) : null;
  const cached = key ? ctx.meetingCache?.get(key) : undefined;
  let doc: MeetingDocument;
  let view: MeetingView | null = null;
  let generation: "rules" | "model_synthesised" = "rules";
  const notes: string[] = [];
  const extraGaps: CoverageGap[] = [];
  if (cached && req.output !== "content") {
    doc = cached.doc; view = cached.view; generation = "model_synthesised"; extraGaps.push(...cached.extra_gaps); notes.push(...cached.notes);
  } else {
    const read = await runBrainTool(ctx, PROVIDER.read, { id: chosen.record_id });
    if (!read.ok) {
      const why = read.reason === "permission_denied"
        ? "I found the page but Notion would not let me read it. It may not be shared with the Broko integration."
        : `I found the meeting but could not read it: ${REASON[read.reason as ToolFailure].detail}`;
      return unavailable(ctx, `${why} Nothing was substituted.`, REASON[read.reason as ToolFailure]);
    }
    const got = read.native as MeetingDocument | undefined;
    if (!got || !Array.isArray(got.segments)) return unavailable(ctx, "I could not read the meeting content. Nothing was substituted.", REASON.error);
    doc = got;

    // analyse and validate. The analysis always covers the whole meeting, so it can answer the next question about it without another model call.
    if (req.output !== "content") {
      if (!ctx.synthesizer) {
        notes.push("AI analysis is not available here, so this shows the page's own text and structure. No summary was written.");
      } else {
        const pkg = buildPackage(doc, "all");
        if (pkg.included.size === 0) {
          notes.push("The page had no analysable text, so this shows what the page contains.");
        } else {
          const res = await ctx.synthesizer.run(ctx.user.id, { system: pkg.system, user: pkg.user, maxTokens: MAX_OUTPUT_TOKENS });
          if (!res.ok) {
            notes.push(res.reason === "budget" ? "The AI analysis budget is used up for now, so this shows the page's own text and structure." : "The AI analysis was not available just now, so this shows the page's own text and structure.");
          } else {
            const v = validateAnalysis(res.text, pkg, doc);
            if (!v.ok) {
              notes.push("The AI analysis did not pass the checks against the page, so it was discarded and this shows the page's own text and structure.");
            } else {
              view = v.view;
              generation = "model_synthesised";
              if (pkg.truncated) extraGaps.push("model_input_limit");
              if (pkg.omitted_flagged > 0) notes.push(`${pkg.omitted_flagged} passage${pkg.omitted_flagged === 1 ? "" : "s"} looked like instructions and ${pkg.omitted_flagged === 1 ? "was" : "were"} not analysed.`);
              if (v.stats.dropped > 0) notes.push(`${v.stats.dropped} statement${v.stats.dropped === 1 ? "" : "s"} from the AI could not be traced to the page and ${v.stats.dropped === 1 ? "was" : "were"} removed.`);
              if (v.stats.unsupported_owner_or_deadline > 0) notes.push("An owner or deadline the AI proposed was not written in the page and was left out.");
              if (key) ctx.meetingCache?.set(key, { doc, view, extra_gaps: [...extraGaps], notes: [...notes] });
            }
          }
        }
      }
    }
  }
  if (doc.segments.some((s) => s.flagged) && generation === "rules") notes.push("Some passages look like instructions. They are shown as text only and were not acted on.");
  if (sel.time_unverified) notes.push("The page records a date but no time of day, so I could not check the time you gave.");

  const record: RetrievedRecord = {
    source: "documents", type: "external_page", ref: /^[A-Za-z0-9_-]{1,64}$/.test(doc.record_id) ? doc.record_id : null, label: doc.title, timestamp: doc.retrieved_at,
    scope: "organization", provenance: "live", flagged: false, attrs: {},
  };
  const src = report("live", "Read from Notion just now: the page, its nested content and child pages. Only pages shared with Broko can be read.", { retrieved_at: doc.retrieved_at });

  if (!req.tz_explicit && (req.date || req.time || req.window)) notes.push(`Dates and times in your question were read in ${req.tz_label}.`);
  if (req.output === "content") {
    const focus = focusFor(doc, deterministicView(doc), req);
    return finish(ctx, {
      intent: "knowledge", text: `Here is the text of ${doc.title}${whenText(doc, req.tz) ? ` (${whenText(doc, req.tz)})` : ""}, exactly as written.`, sources: [src], used: [record], evidence: true,
      sections: [...contentSections(doc), { kind: "facts", heading: "Source", items: [{ text: doc.title, source: "documents", ...(doc.url ? { external_url: doc.url } : {}) }] }],
      extra: { ...noticeOf(notes), follow_ups: nextQuestions("content"), generation: "rules", quiet: true, ...(focus ? { focus } : {}) },
    });
  }
  const shown = view ?? deterministicView(doc);
  const out = formatMeeting({ doc, req, view: shown, extraGaps, notes: [], now: ctx.now });
  const focus = focusFor(doc, shown, req);
  return finish(ctx, {
    intent: "knowledge", text: out.text, sections: out.sections, sources: [src], used: [record], evidence: true,
    extra: { ...noticeOf(notes), follow_ups: nextQuestions(req.output), generation, quiet: true, ...(focus ? { focus } : {}) },
  });
}
