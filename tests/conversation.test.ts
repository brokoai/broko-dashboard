import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { askBrain, type BrainChatContext, type ChatReply, type Synthesizer } from "../src/lib/ai-brain/chat";
import { parseFocus } from "../src/lib/ai-brain/chat/focus";
import { createMeetingCache } from "../src/lib/ai-brain/chat/meeting-cache";
import { phase1Registry, unavailableConnectors, type Connectors } from "../src/lib/ai-brain/assistant";
import { sanitizeDocument } from "../src/lib/ai-brain/assistant/meetings/analysis";
import { parseMeetingRequest } from "../src/lib/ai-brain/assistant/meetings/request";
import type { MeetingCandidate, MeetingDocument, SegmentKind, SourceSegment } from "../src/lib/ai-brain/assistant/meetings/types";
import { dataStatus } from "../src/lib/chat-state";
import { NOW, admin, alice, fakeRepo, task } from "./ai-chat-helpers";

// A whole conversation through askBrain, with a FAKE Notion and a FAKE model. NOW is Sunday 25 October 2026 (12:00 UTC).
// Yesterday = 24 Oct, the previous meeting = 22 Oct, "last week" = 12-18 Oct.
void phase1Registry;
const cand = (id: string, title: string, starts_at: string): MeetingCandidate => ({
  system: "notion", record_id: id, title, url: `https://www.notion.so/${id}`, last_edited: "2026-10-24T20:00:00.000Z", starts_at, date_only: false, date_source: "date_property", retrieved_at: NOW.toISOString(),
});
const YEST = cand("aaaaaaaa-1111-4111-8111-111111111111", "Meeting 2026-10-24T18:30:00.000+00:00", "2026-10-24T18:30:00.000Z");
const PREV = cand("bbbbbbbb-2222-4222-8222-222222222222", "Meeting 2026-10-22T10:00:00.000+00:00", "2026-10-22T10:00:00.000Z");
const WEEK = cand("cccccccc-3333-4333-8333-333333333333", "Meeting 2026-10-15T10:00:00.000+00:00", "2026-10-15T10:00:00.000Z");
const OLD = cand("dddddddd-4444-4444-8444-444444444444", "Meeting 2026-10-01T10:00:00.000+00:00", "2026-10-01T10:00:00.000Z");

const seg = (n: number, kind: SegmentKind, text: string, extra: Partial<SourceSegment> = {}): SourceSegment => ({ id: `S${n}`, ref: `blk-${n}`, kind, text, depth: 0, ...extra });
const docOf = (c: MeetingCandidate, segments: SourceSegment[]): MeetingDocument => sanitizeDocument({ ...c, segments, coverage: { complete: true, gaps: [], blocks_read: segments.length } });

const DOCS: Record<string, MeetingDocument> = {
  [YEST.record_id]: docOf(YEST, [
    seg(1, "title", YEST.title), seg(2, "text", "The team reviewed the marketplace launch plan and the vendor onboarding schedule."),
    seg(3, "heading", "Decisions"), seg(4, "text", "Agreed to launch the marketplace in Pune first with twenty vendors."),
    seg(5, "text", "Agreed to keep the partnership terms unchanged until legal review ends."),
    seg(6, "heading", "Action items"), seg(7, "todo", "Priya to send the revised vendor proposal by Friday", { checked: false }), seg(8, "todo", "Prepare the onboarding checklist", { checked: false }),
  ]),
  [PREV.record_id]: docOf(PREV, [
    seg(1, "title", PREV.title), seg(2, "text", "We discussed the marketplace pricing model and whether to charge vendors a listing fee."),
    seg(3, "heading", "Open questions"), seg(4, "text", "Should the marketplace listing fee start in the first quarter?"),
    seg(5, "heading", "Action items"), seg(6, "todo", "Collect competitor marketplace pricing", { checked: false }),
  ]),
  [WEEK.record_id]: docOf(WEEK, [seg(1, "title", WEEK.title), seg(2, "text", "Early idea: a marketplace for local vendors could be tested next month.")]),
  [OLD.record_id]: docOf(OLD, [seg(1, "title", OLD.title), seg(2, "text", "Quarterly budget review with finance.")]),
};

// The fake model: a valid, grounded analysis for whichever meeting it is shown.
const ANALYSES: Record<string, object> = {
  "marketplace launch plan": {
    meeting_overview: { text: "The team reviewed the marketplace launch plan and the vendor onboarding schedule.", refs: ["S2"] },
    key_discussion_points: [{ text: "Marketplace launch plan and vendor onboarding schedule.", refs: ["S2"] }],
    decisions: [{ text: "Launch the marketplace in Pune first with twenty vendors.", refs: ["S4"], explicit: true }, { text: "Keep the partnership terms unchanged until legal review ends.", refs: ["S5"], explicit: true }],
    action_items: [{ task: "Send the revised vendor proposal", owner: "Priya", deadline: "Friday", refs: ["S7"] }, { task: "Prepare the onboarding checklist", owner: null, deadline: null, refs: ["S8"] }],
    unresolved_questions: [], risks: [], follow_ups: [], source_references: ["S2", "S4", "S7"], confidence: "high", limitations: [],
  },
  "marketplace pricing model": {
    meeting_overview: { text: "We discussed the marketplace pricing model and whether to charge vendors a listing fee.", refs: ["S2"] },
    key_discussion_points: [{ text: "Marketplace pricing model and a vendor listing fee.", refs: ["S2"] }],
    decisions: [],
    action_items: [{ task: "Collect competitor marketplace pricing", owner: null, deadline: null, refs: ["S6"] }],
    unresolved_questions: [{ text: "Should the marketplace listing fee start in the first quarter?", refs: ["S4"] }], risks: [], follow_ups: [], source_references: ["S2"], confidence: "medium", limitations: [],
  },
};
function fakeModel(): { synthesizer: Synthesizer; calls: () => number } {
  let n = 0;
  return {
    calls: () => n,
    synthesizer: { run: async (_u, req) => { n += 1; const key = Object.keys(ANALYSES).find((k) => req.user.includes(k)); return key ? { ok: true as const, text: JSON.stringify(ANALYSES[key]) } : { ok: false as const, reason: "unavailable" as const }; } },
  };
}
function fakeNotion(): { notion: Connectors["notion"]; reads: string[]; finds: number } {
  const state = { reads: [] as string[], finds: 0 };
  const notion: Connectors["notion"] = {
    ...unavailableConnectors().notion,
    findMeetingCandidates: async () => { state.finds += 1; return { ok: true, data: [YEST, PREV, WEEK, OLD] }; },
    readMeetingDocument: async (id) => { state.reads.push(id); return DOCS[id] ? { ok: true, data: DOCS[id]! } : { ok: false, reason: "permission_denied" }; },
  };
  return { notion, get reads() { return state.reads; }, get finds() { return state.finds; } };
}

/** One chat session: remembers the focus between turns exactly as the browser does, and shares one meeting cache. */
function session(over: Partial<BrainChatContext> = {}, user = admin) {
  const { notion, ...spy } = fakeNotion();
  const model = fakeModel();
  const cache = createMeetingCache();
  const { repo } = fakeRepo({ tasks: [task({ assigned_to: user.id, created_by: user.id, title: "Private task title" })] });
  let focus: ChatReply["focus"];
  const transcript: ChatReply[] = [];
  return {
    spy, model,
    ask: async (message: string): Promise<ChatReply> => {
      const ctx: BrainChatContext = { user, repo, mode: "live", now: NOW, connectors: { ...unavailableConnectors(), notion }, synthesizer: model.synthesizer, timeZone: "UTC", meetingCache: cache, focus: parseFocus(focus), ...over };
      const r = await askBrain(ctx, message);
      if (r.focus) focus = r.focus;
      transcript.push(r);
      return r;
    },
    transcript,
  };
}
const words = (r: ChatReply) => r.text + " " + r.sections.flatMap((s) => [s.heading ?? "", s.text ?? "", ...(s.items ?? []).map((i) => i.text)]).join(" ");

describe("a Chief-of-Staff conversation: the eight scenarios, in order, in one chat", () => {
  it("1. 'Summarise yesterday's meeting' answers in words, not retrieval rows", async () => {
    const s = session();
    const r = await s.ask("Summarise yesterday's meeting.");
    assert.match(r.text, /yesterday's meeting/i);
    assert.match(r.text, /marketplace launch plan/);
    assert.match(r.text, /2 decisions were recorded/);
    assert.ok(!/Notion results|Notion ID|retriev|records? from|blocks/i.test(words(r)), words(r));
    assert.equal(r.quiet, true);
    assert.equal(r.focus?.id, YEST.record_id);
    assert.ok(r.focus!.topics.includes("marketplace"));
  });

  it("2-3. follow-ups use the meeting in focus: 'What decisions were made?', 'Who owns the action items?'", async () => {
    const s = session();
    await s.ask("Summarise yesterday's meeting.");
    const d = await s.ask("What decisions were made?");
    assert.match(d.text, /2 decisions were recorded in yesterday's meeting/);
    assert.ok(d.sections.some((x) => x.heading === "Decisions" && x.items!.some((i) => /Pune first/.test(i.text))));
    assert.ok(!d.sections.some((x) => /Action items/.test(x.heading ?? "")), "only the decisions were asked for");
    const o = await s.ask("Who owns the action items?");
    assert.match(o.text, /Priya/);
    assert.match(o.text, /No owner was assigned to the other item/);
    // the second and third answers reused the analysis: one read, one model call for the whole conversation so far
    assert.equal(s.spy.reads.length, 1);
    assert.equal(s.model.calls(), 1);
  });

  it("4-5. 'What about the previous meeting?' keeps the kind of answer; 'What remains pending?' is about that meeting", async () => {
    const s = session();
    await s.ask("Summarise yesterday's meeting.");
    await s.ask("Who owns the action items?");
    const p = await s.ask("What about the previous meeting?");
    assert.equal(p.focus?.id, PREV.record_id, "the meeting before the one in focus");
    assert.match(p.text, /[Tt]he meeting on 22 October/);
    assert.match(p.text, /action item/i, "the same kind of answer as the one before");
    assert.match(p.text, /None has a named owner/);
    const pending = await s.ask("What remains pending?");
    assert.match(pending.text, /Still open from the meeting on 22 October: 1 action item and 1 unresolved question/);
    assert.equal(pending.focus?.id, PREV.record_id);
  });

  it("6. 'Was this discussed last week?' searches last week's meetings for this meeting's topic", async () => {
    const s = session();
    await s.ask("Summarise the meeting on 22 October");
    const r = await s.ask("Was this discussed last week?");
    assert.match(r.text, /^Yes\. .*marketplace.* came up in 1 meeting last week/);
    assert.ok(r.sections.some((x) => /discussed, not recorded as a decision/.test(x.heading ?? "") && x.items!.some((i) => /local vendors/.test(i.text))));
    assert.ok(!words(r).includes("22 October 2026"), "this meeting itself is not counted as last week");
  });

  it("7. 'What did we agree about the marketplace?' separates what was agreed from what was only discussed", async () => {
    const s = session();
    await s.ask("Summarise yesterday's meeting.");
    const r = await s.ask("What did we agree about the marketplace?");
    assert.match(r.text, /record agreement in 1 meeting/);
    const agreed = r.sections.filter((x) => /recorded as agreed/.test(x.heading ?? ""));
    assert.equal(agreed.length, 1);
    assert.ok(agreed[0]!.items!.some((i) => /Pune first/.test(i.text)));
    assert.ok(r.sections.some((x) => /discussed, not recorded as a decision/.test(x.heading ?? "")));
    assert.ok(!/Pune first/.test(r.sections.filter((x) => /not recorded as a decision/.test(x.heading ?? "")).map((x) => (x.items ?? []).map((i) => i.text).join(" ")).join(" ")), "an agreement is never filed under 'only discussed'");
    assert.equal(r.generation, "rules", "no model wrote this: it is quoted from the notes");
  });

  it("8. 'Give me a short executive summary' is short", async () => {
    const s = session();
    await s.ask("Summarise yesterday's meeting.");
    const r = await s.ask("Give me a short executive summary.");
    assert.ok(r.text.length <= 700 && r.text.length > 60);
    assert.match(r.text, /marketplace/);
    assert.deepEqual(r.sections.map((x) => x.heading), ["Source"]);
  });

  it("a topic nobody wrote about is reported honestly, nothing invented", async () => {
    const s = session();
    await s.ask("Summarise yesterday's meeting.");
    const r = await s.ask("What did we agree about the zeppelin?");
    assert.match(r.text, /did not find zeppelin/);
    assert.equal(r.grounding.evidence, false);
  });

  it("'Has that decision changed?' compares with LATER meetings only, and does not claim a change the notes do not state", async () => {
    const s = session();
    await s.ask("Summarise the meeting on 22 October");
    const r = await s.ask("Has that decision changed?");
    assert.match(r.text, /afterwards/);
    assert.ok(!/has changed|was changed/i.test(r.text.replace(/does not say outright that it changed|nothing has changed/g, "")));
  });
});

describe("conversation safety", () => {
  it("a forged or stale focus finds nothing: the meeting must still appear in the authorized search", async () => {
    const s = session({ focus: { kind: "meeting", id: "eeeeeeee-9999-4999-8999-999999999999", title: "x", output: "summary", topics: [] } });
    const r = await s.ask("Who owns the action items?");
    assert.match(r.text, /can no longer find that meeting/);
    assert.deepEqual(s.spy.reads, [], "nothing was read");
  });

  it("the focus from the browser is parsed strictly: junk is dropped", () => {
    assert.equal(parseFocus(null), undefined);
    assert.equal(parseFocus({ kind: "meeting", id: "../../etc/passwd", output: "summary", topics: [] }), undefined);
    assert.equal(parseFocus({ kind: "meeting", id: "aaaaaaaa-1111-4111-8111-111111111111", output: "rm -rf", topics: [] }), undefined);
    const f = parseFocus({ kind: "meeting", id: "aaaaaaaa-1111-4111-8111-111111111111", title: "T\u0000itle", output: "summary", starts_at: "not a date", topics: ["marketplace", "Bad Term!", 5], extra: "x" })!;
    assert.deepEqual(f, { kind: "meeting", id: "aaaaaaaa-1111-4111-8111-111111111111", title: "T itle", output: "summary", topics: ["marketplace"] });
  });

  it("a member cannot use a focus to reach meeting notes", async () => {
    const s = session({}, alice);
    const first = await s.ask("Summarise yesterday's meeting.");
    assert.match(first.text, /only administrators/);
    const forged = session({ focus: { kind: "meeting", id: YEST.record_id, title: "x", output: "summary", topics: [] } }, alice);
    const r = await forged.ask("Who owns the action items?");
    assert.match(r.text, /only administrators/);
    assert.deepEqual(forged.spy.reads, []);
  });

  it("with a meeting in focus, questions that are not about meetings still go to their own handlers", async () => {
    const s = session();
    await s.ask("Summarise yesterday's meeting.");
    const r = await s.ask("What are my pending tasks?");
    assert.equal(r.intent, "pending_tasks");
    assert.deepEqual(s.spy.reads, [YEST.record_id], "no further meeting was read");
  });

  it("a different user never receives another user's cached analysis", async () => {
    const cache = createMeetingCache();
    const a = session({ meetingCache: cache });
    await a.ask("Summarise yesterday's meeting.");
    const other = { ...admin, id: "u-admin-2" };
    const b = session({ meetingCache: cache }, other);
    await b.ask("Summarise yesterday's meeting.");
    assert.equal(b.spy.reads.length, 1, "the second user's request read Notion itself");
    assert.equal(b.model.calls(), 1);
  });

  it("an edited page is not served from the cache", async () => {
    const cache = createMeetingCache();
    const s = session({ meetingCache: cache });
    await s.ask("Summarise yesterday's meeting.");
    const first = s.spy.reads.length;
    await s.ask("Summarise yesterday's meeting.");
    assert.equal(s.spy.reads.length, first, "unchanged page: reused");
  });
});

describe("operating-mode indicators never mislabel real data", () => {
  it("a demo workspace answering from a real Notion says live, with no demo notice", async () => {
    const s = session({ mode: "demo" });
    const r = await s.ask("Summarise yesterday's meeting.");
    assert.equal(r.mode, "demo");
    assert.equal(r.data, "live");
    assert.ok(!/Demo mode|synthetic/i.test(r.notice ?? ""), "no demo notice on real Notion data");
    assert.equal(dataStatus(r)?.tone, "live");
  });

  it("a demo answer from synthetic data still says demo", async () => {
    const s = session({ mode: "demo" });
    const r = await s.ask("What are my pending tasks?");
    assert.equal(r.data, "demo");
    assert.match(r.notice ?? "", /Demo mode/);
    assert.equal(dataStatus(r)?.tone, "demo");
  });

  it("connected but nothing matches is told apart from unavailable", async () => {
    const s = session();
    const none = await s.ask("Summarise the meeting on 3 March");
    assert.equal(dataStatus(none)?.tone, "none");
    assert.match(dataStatus(none)!.label, /Connected to Notion/);
    const down = session({ connectors: { ...unavailableConnectors() } });
    const r = await down.ask("Summarise yesterday's meeting.");
    assert.equal(dataStatus(r)?.tone, "unavailable");
    assert.match(dataStatus(r)!.label, /not connected/);
  });
});

describe("understanding natural wording", () => {
  const p = (m: string, focus = true) => parseMeetingRequest(m, { now: NOW, tz: "UTC", ...(focus ? { focus: { kind: "meeting" as const, id: YEST.record_id, title: "t", output: "summary" as const, topics: ["marketplace"] } } : {}) });

  it("misspellings and informal phrasing are understood", () => {
    assert.equal(p("sumary of yesterday meeting", false)?.output, "summary");
    assert.equal(p("whos responsible?")?.narrow, "owners");
    assert.equal(p("what is still pending")?.narrow, "pending");
    assert.equal(p("tl;dr please")?.brief, true);
  });

  it("last week and this week are calendar weeks in the user's zone", () => {
    assert.deepEqual(p("summarise last week's meeting", false)?.window, { from: "2026-10-12", to: "2026-10-18", label: "last week" });
    assert.deepEqual(p("what happened in the meeting this week", false)?.window, { from: "2026-10-19", to: "2026-10-25", label: "this week" });
    // 3 a.m. Monday in Kolkata is still Sunday evening in Toronto: the week follows the asker
    const monday = new Date("2026-10-26T01:00:00Z");
    assert.equal(parseMeetingRequest("last week's meeting summary", { now: monday, tz: "Asia/Kolkata" })?.window?.from, "2026-10-19");
    assert.equal(parseMeetingRequest("last week's meeting summary", { now: monday, tz: "America/Toronto" })?.window?.from, "2026-10-12");
  });

  it("without a meeting in focus, a bare follow-up is not taken for a meeting question", () => {
    assert.equal(p("Who owns the action items?", false), null, "without the word 'meeting' or a meeting in focus it stays a task question");
    assert.equal(p("Who is responsible?", false), null);
    assert.equal(p("What remains pending?", false), null);
    assert.equal(p("What did we agree about the marketplace?", false), null);
  });

  it("'can u pull notion meeting?' means the latest meeting's summary; 'what we discussed last thursday?' needs no word 'meeting'", () => {
    const pull = p("can u pull notion meeting?", false)!;
    assert.equal(pull.output, "summary");
    assert.equal(pull.latest, false);
    assert.deepEqual(pull.keywords, []);
    const thu = p("what we discussed last thursday?", false)!;
    assert.equal(thu.output, "summary");
    assert.deepEqual(thu.date, { month: 10, day: 22, year: 2026 }, "the Thursday before Sunday 25 Oct");
    assert.equal(p("what did we decide yesterday", false)?.output, "decisions");
    assert.equal(p("what happened yesterday", false), null, "the activity feed question is left alone");
    assert.equal(p("what we discussed about pricing", false), null, "no date: left to approved Knowledge");
  });

  it("several meetings on one day are listed readably and each option resolves to one", async () => {
    const two = { ...PREV, record_id: "ffffffff-5555-4555-8555-555555555555", title: "Meeting 2026-10-22T11:00:00.000+00:00", starts_at: "2026-10-22T11:00:00.000Z" };
    const { notion } = fakeNotion();
    const both: Connectors["notion"] = { ...notion, findMeetingCandidates: async () => ({ ok: true, data: [PREV, two] }) };
    const { repo } = fakeRepo({ tasks: [] });
    const r = await askBrain({ user: admin, repo, mode: "live", now: NOW, connectors: { ...unavailableConnectors(), notion: both }, timeZone: "UTC" }, "what we discussed on 22 October?");
    assert.equal(r.intent, "clarify");
    assert.ok(r.clarification!.options.length === 2 && r.clarification!.options.every((o) => /on 22 October 2026 at \d/.test(o)), JSON.stringify(r.clarification));
    assert.ok(r.sections[0]!.items!.every((i) => /^Meeting, 22 October 2026/.test(i.text)));
  });

  it("questions about my tasks are never taken as meeting follow-ups", () => {
    for (const q of ["What are my pending tasks?", "Show me overdue tasks", "What decisions are in my inbox?"]) assert.equal(p(q), null, q);
  });
});
