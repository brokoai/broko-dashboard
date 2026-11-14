import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { askBrain, createMemoryRateLimiter, type BrainChatContext, type ChatReply } from "../src/lib/ai-brain/chat";
import { AGENT_SYSTEM_PROMPT, createToolAgent, isCoverageStatement, weeksLine, weekdayDatesLine, type ToolAgent } from "../src/lib/ai-brain/chat/tool-agent";
import { phase1Tools, ToolRegistry, unavailableConnectors } from "../src/lib/ai-brain/assistant";
import type { ToolTransport, ToolTurn, ToolTurnRequest } from "../src/lib/ai-brain/model-tool-transport";
import { fakeModel, fakeNotion, YEST } from "./nl-cases";
import { NOW, admin, fakeRepo } from "./ai-chat-helpers";

// Structured answers: the model delivers ONE submit_answer({items:[{text, cites}]}) call; every factual item carries its own citations, and any failure declines the whole answer.

const call = (name: string, input: unknown): ToolTurn => ({ blocks: [{ type: "tool_use", id: `tu_${Math.random().toString(36).slice(2, 8)}`, name, input }], stopReason: "tool_use", usage: { input: 100, output: 20 } });
const submit = (items: unknown) => call("submit_answer", { items });
const READ = call("notion_meetings_read", { id: YEST.record_id });
function script(turns: ToolTurn[]) {
  const requests: ToolTurnRequest[] = [];
  let i = 0;
  const transport: ToolTransport = async (req) => { requests.push(JSON.parse(JSON.stringify(req)) as ToolTurnRequest); return turns[Math.min(i++, turns.length - 1)]!; };
  return { transport, requests };
}
function run(turns: ToolTurn[]) {
  const s = script(turns);
  const agent: ToolAgent = createToolAgent({ transport: s.transport, limiter: createMemoryRateLimiter({ maxCalls: 100 }) });
  const ran: string[] = [];
  const tools = new ToolRegistry(phase1Tools().map((c) => (c.run ? { ...c, run: async (i: unknown, ctx: Parameters<NonNullable<typeof c.run>>[1]) => { ran.push(c.id); return c.run!(i, ctx); } } : c)));
  const { repo } = fakeRepo({});
  const ctx: BrainChatContext = { user: admin, repo, mode: "live", now: NOW, tools, connectors: { ...unavailableConnectors(), notion: fakeNotion() }, synthesizer: fakeModel(), timeZone: "UTC", toolAgent: agent };
  return askBrain(ctx, "Summarise yesterday's meeting.").then((reply) => ({ reply, ran, requests: s.requests }));
}
const text = (r: ChatReply) => `${r.text} ${r.sections.flatMap((s) => [s.heading ?? "", ...(s.items ?? []).map((i) => i.text)]).join(" ")}`;
const viaTools = (r: ChatReply) => r.sections[0]?.heading === "From the meeting notes";

const A = { text: "They agreed to launch the marketplace in Pune first with twenty vendors.", cites: ["M1.S4"] };
const B = { text: "They also agreed to keep the partnership terms unchanged until legal review ends.", cites: ["M1.S5"] };
const U = { text: "The finance team approved a five million budget for the launch.", cites: [] as string[] };
/** A failed validation declines the WHOLE answer: the ordinary Brain answers from the source, and nothing the model submitted is shown. */
async function declined(items: unknown, why: string) {
  const { reply } = await run([READ, submit(items)]);
  assert.ok(!viaTools(reply), `declined: ${why}`);
  assert.ok(!/finance team|five million|marketing budget|Bob/.test(text(reply)), `nothing submitted is shown: ${why}`);
  assert.match(text(reply), /Pune/, "the ordinary handler answered from the source");
  assert.equal(reply.generation, "model_synthesised", "by the existing meeting analysis, with its own validation");
}

describe("structured answers: accepted", () => {
  it("a fully cited answer is shown in full, with each item's own references", async () => {
    const { reply, ran } = await run([READ, submit([A, B])]);
    assert.ok(viaTools(reply));
    assert.equal(reply.text, `${A.text} ${B.text}`);
    assert.deepEqual(reply.sections[0]!.items![0]!.cite, ["S4", "S5"]);
    assert.deepEqual(ran, ["notion.meetings.read"], "submit_answer never reaches the Registry");
  });
  it("one item may cite several segments; several items cite independently", async () => {
    const multi = { text: "The meeting settled the launch city and the partnership terms.", cites: ["M1.S4", "M1.S5"] };
    const one = await run([READ, submit([multi])]);
    assert.ok(viaTools(one.reply));
    assert.deepEqual(one.reply.sections[0]!.items![0]!.cite, ["S4", "S5"]);
    const sameSeg = await run([READ, submit([A, { text: "Twenty vendors will take part in the Pune launch.", cites: ["M1.S4"] }])]);
    assert.ok(viaTools(sameSeg.reply), "the same segment may support two items, each stating it for itself");
  });
  it("bullets and lead-ins keep their own lines", async () => {
    const { reply } = await run([READ, submit([{ text: "Action items:", cites: [] }, { text: "- Priya is to send the revised vendor proposal by Friday.", cites: ["M1.S7"] }, { text: "- Someone is to prepare the onboarding checklist.", cites: ["M1.S8"] }])]);
    assert.ok(viaTools(reply));
    assert.equal(reply.text, "Action items:\n- Priya is to send the revised vendor proposal by Friday.\n- Someone is to prepare the onboarding checklist.");
  });
  it("the last turn is forced to submit; earlier turns are not", async () => {
    const { requests } = await run([call("notion_meetings_find", { keywords: [], limit: 25 }), READ, submit([A, B])]);
    assert.equal(requests.length, 3);
    assert.equal(requests[0]!.toolChoice, undefined);
    assert.deepEqual(requests[2]!.toolChoice, { tool: "submit_answer" });
    assert.ok(requests[0]!.tools.some((t) => t.name === "submit_answer"));
  });
});

describe("structured answers: the whole answer is declined, never trimmed", () => {
  it("an uncited FIRST item", async () => { await declined([U, A, B], "first"); });
  it("an uncited MIDDLE item", async () => { await declined([A, U, B], "middle"); });
  it("an uncited LAST item", async () => { await declined([A, B, U], "last"); });
  it("an undelivered, invented or malformed citation on any item", async () => {
    await declined([A, { ...U, cites: ["M1.S99"] }, B], "segment never delivered");
    await declined([A, { ...U, cites: ["M2.S1"] }, B], "meeting never read");
    await declined([A, B, { ...U, cites: ["S4"] }], "malformed id");
    await declined([A, B, { ...U, cites: ["[M1.S4]"] }], "bracketed id");
    await declined([A, B, { ...U, cites: ["M1.S4", "M1.S99"] }], "one good id does not rescue a bad one");
    await declined([{ ...A, cites: ["M1.S4", "M3.S1"] }, B], "valid plus invalid on a supported item");
  });
  it("mixed cited and uncited items", async () => {
    await declined([A, { text: "The budget was doubled by finance this quarter.", cites: [] }, { text: "Hiring for the marketplace team starts next week.", cites: [] }, B], "mostly uncited");
    await declined([A, B, A, B, U], "one uncited among many");
  });
  it("one citation list may not silently cover two statements in one item", async () => {
    await declined([{ text: `${A.text} ${U.text}`, cites: ["M1.S4"] }], "two factual sentences in one item");
  });
  it("a citation marker written inside the text is not a citation", async () => {
    await declined([{ text: "They agreed to launch the marketplace in Pune first with twenty vendors [M1.S4].", cites: [] }], "marker in text, empty cites");
    await declined([{ ...A, text: "They agreed to launch the marketplace in Pune first with twenty vendors [M1.S4]." }, B], "marker in text");
  });
  it("empty or malformed structured output", async () => {
    for (const bad of [[], undefined, null, "text", 5, {}, [{ text: "x" }], [{ cites: ["M1.S4"] }], [{ text: "", cites: ["M1.S4"] }], [{ ...A, extra: 1 }], [{ ...A, cites: "M1.S4" }], [{ ...A, cites: [4] }], [A, null], Array.from({ length: 31 }, () => A)]) {
      await declined(bad, JSON.stringify(bad)?.slice(0, 60) ?? "undefined");
    }
    const { reply } = await run([READ, call("submit_answer", "not an object")]);
    assert.ok(!viaTools(reply));
    const bareObject = await run([READ, call("submit_answer", { items: A, other: 1 })]);
    assert.ok(!viaTools(bareObject.reply));
  });
  it("plain text is never accepted as the answer, with or without markers", async () => {
    const plain = (t: string): ToolTurn => ({ blocks: [{ type: "text", text: t }], stopReason: "end_turn", usage: { input: 1, output: 1 } });
    for (const t of ["They agreed to launch the marketplace in Pune first with twenty vendors [M1.S4].", "They agreed to launch the marketplace in Pune first with twenty vendors."]) {
      const { reply } = await run([READ, plain(t)]);
      assert.ok(!viaTools(reply));
      assert.match(text(reply), /Pune/);
      assert.equal(reply.generation, "model_synthesised");
    }
  });
  it("submitting before reading anything is not an answer", async () => {
    const { reply, ran } = await run([submit([A, B])]);
    assert.ok(!viaTools(reply));
    assert.ok(!ran.includes("never"), "no tool ran for the model");
  });
  it("submit_answer in the same turn as a read is refused; the read still happens and a later submit works", async () => {
    const both: ToolTurn = { blocks: [...READ.blocks, ...submit([A, B]).blocks], stopReason: "tool_use", usage: { input: 1, output: 1 } };
    const { reply, ran, requests } = await run([both, submit([A, B])]);
    assert.deepEqual(ran.filter((r) => r.startsWith("notion.meetings.read")), ["notion.meetings.read"]);
    assert.match(JSON.stringify(requests[1]!.messages.at(-1)), /Read the meeting first/);
    assert.ok(viaTools(reply));
  });
});

describe("structured answers: source-coverage statements stay narrow", () => {
  it("the Hinglish coverage statement needs no citation", async () => {
    assert.equal(isCoverageStatement("Checklist ka owner notes mein nahi likha hai."), true);
    assert.equal(isCoverageStatement("Deadline meeting notes me nahi bataya gaya."), true, "a listed verb: the notes did not state it");
    assert.equal(isCoverageStatement("Budget notes mein nahi approve hua."), false, "only the listed verbs are accepted");
    const { reply } = await run([READ, submit([A, { text: "Checklist ka owner notes mein nahi likha hai.", cites: [] }])]);
    assert.ok(viaTools(reply));
    assert.match(reply.text, /Checklist ka owner notes mein nahi likha hai\./);
  });
  it("Hinglish claims about people or events do not get it", () => {
    for (const no of ["CEO ne budget approve notes mein nahi likha hai.", "Budget approve nahi hua, notes mein nahi likha hai.", "CEO ne budget approve nahi kiya.", "Priya ne meeting join nahi ki.", "Checklist ka owner Bob hai, notes mein nahi likha hai.", "Notes mein likha hai ki Bob ne budget approve kiya."]) {
      assert.equal(isCoverageStatement(no), false, no);
    }
  });
  it("ordinary negative claims about people, decisions or events are not exempt and decline the answer", async () => {
    for (const claim of ["The CEO did not approve the vendor budget for the launch.", "The notes say the CEO did not approve the vendor budget for the launch.", "Nobody objected to the Pune launch plan during the discussion.", "The vendor proposal was not sent to the legal team last week.", "CEO ne budget approve nahi kiya, yeh sab ko pata hai."]) {
      await declined([A, B, { text: claim, cites: [] }], claim);
    }
  });
  it("an English coverage statement still needs no citation, but cannot carry a false one", async () => {
    const ok = await run([READ, submit([A, { text: "The notes don't say which Friday that is.", cites: [] }])]);
    assert.ok(viaTools(ok.reply));
    await declined([A, { text: "The notes don't say who owns the checklist.", cites: ["M1.S99"] }], "false citation on a coverage statement");
  });
});

describe("calendar weeks handed to the model (computed by code, in the user's zone)", () => {
  const at = (iso: string, tz: string) => weeksLine(new Date(iso).getTime(), tz);
  const line = (last: string, thisWeek: string) => `Calendar weeks run Monday to Sunday. Last week = ${last}. This week = ${thisWeek}.`;
  it("on a Sunday, last week is the week before the one that is ending", () => {
    assert.equal(at("2026-10-25T12:00:00Z", "UTC"), line("Monday 12 October 2026 to Sunday 18 October 2026", "Monday 19 October 2026 to Sunday 25 October 2026"));
  });
  it("on a Monday and on a mid-week day, last week is the one just finished", () => {
    assert.equal(at("2026-10-26T12:00:00Z", "UTC"), line("Monday 19 October 2026 to Sunday 25 October 2026", "Monday 26 October 2026 to Sunday 1 November 2026"));
    assert.equal(at("2026-10-28T09:00:00Z", "UTC"), at("2026-10-26T12:00:00Z", "UTC"), "Wednesday and Monday of the same week agree");
    assert.equal(at("2026-10-30T23:59:00Z", "UTC"), at("2026-10-26T12:00:00Z", "UTC"), "Friday late evening too");
  });
  it("uses the user's time zone, not the server's", () => {
    // 2026-10-26T02:00Z is still Sunday evening in Toronto (EDT) but already Monday in UTC.
    assert.equal(at("2026-10-26T02:00:00Z", "America/Toronto"), at("2026-10-25T12:00:00Z", "UTC"));
    assert.equal(at("2026-10-26T02:00:00Z", "UTC"), at("2026-10-26T12:00:00Z", "UTC"));
    // 2026-10-25T23:30Z is Monday 12:30 in Auckland (NZDT).
    assert.equal(at("2026-10-25T23:30:00Z", "Pacific/Auckland"), at("2026-10-26T12:00:00Z", "UTC"));
    assert.notEqual(at("2026-10-25T23:30:00Z", "Pacific/Auckland"), at("2026-10-25T23:30:00Z", "UTC"));
  });
  it("spans the December to January year boundary", () => {
    assert.equal(at("2027-01-04T12:00:00Z", "UTC"), line("Monday 28 December 2026 to Sunday 3 January 2027", "Monday 4 January 2027 to Sunday 10 January 2027"));
    assert.equal(at("2027-01-01T12:00:00Z", "UTC"), line("Monday 21 December 2026 to Sunday 27 December 2026", "Monday 28 December 2026 to Sunday 3 January 2027"));
    assert.equal(at("2026-12-27T12:00:00Z", "UTC"), line("Monday 14 December 2026 to Sunday 20 December 2026", "Monday 21 December 2026 to Sunday 27 December 2026"));
  });
  it("last week and this week never overlap and always meet", () => {
    for (const d of ["2026-10-25", "2026-10-26", "2026-12-31", "2027-01-03", "2028-02-29", "2026-03-29"]) {
      const l = at(`${d}T12:00:00Z`, "UTC");
      assert.match(l, /^Calendar weeks run Monday to Sunday\. Last week = Monday .+ to Sunday .+\. This week = Monday .+ to Sunday .+\.$/);
    }
  });
  it("the model is given the weeks in its first message, and told not to recompute or explain them", async () => {
    const { requests } = await run([READ, submit([A, B])]);
    assert.match(String(requests[0]!.messages[0]!.content), /Last week = Monday 12 October 2026 to Sunday 18 October 2026\. This week = Monday 19 October 2026 to Sunday 25 October 2026\./);
    assert.match(AGENT_SYSTEM_PROMPT, /never recompute them/);
    assert.match(AGENT_SYSTEM_PROMPT, /Do not state a week or date range/);
    assert.match(AGENT_SYSTEM_PROMPT, /ONE short clause/);
  });
  it("without the request's clock the agent states no weeks at all", async () => {
    const s = script([call("notion_meetings_read", { id: YEST.record_id }), submit([A, B])]);
    const agent = createToolAgent({ transport: s.transport, limiter: createMemoryRateLimiter({ maxCalls: 10 }) });
    await agent.run({ userId: "u", role: "admin", message: "last week?", today: "Sunday 25 October 2026", timeZone: "UTC", recent: [], contracts: phase1Tools(), run: async () => ({ ok: false, code: "denied", detail: "x" }) as never });
    assert.ok(!/Calendar weeks/.test(String(s.requests[0]!.messages[0]!.content)));
  });
});

describe("relative weekday dates handed to the model (last Thursday is computed by code)", () => {
  const NAMES = ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"];
  const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
  /** The seven "Last <weekday>" dates, Monday first, written as the agent writes them. */
  const map = (...dates: string[]) => `Relative weekday dates (the most recent such day before today): ${dates.map((d, i) => `Last ${NAMES[i]} = ${d}`).join("; ")}.`;
  const oct = (...nums: number[]) => nums.map((d) => `${d} October 2026`);
  const days = (iso: string, tz = "UTC") => weekdayDatesLine(new Date(iso).getTime(), tz);
  const base = { userId: "u", role: "admin" as const, message: "last thursday?", today: "Sunday 25 October 2026", recent: [] as string[], contracts: phase1Tools(), run: async () => ({ ok: false, code: "denied", detail: "x" }) as never };
  const first = (s: { requests: ToolTurnRequest[] }) => String(s.requests[0]!.messages[0]!.content);
  it("Sunday 25 October 2026 (the evaluation's date): last Sunday is a week ago, last Thursday is the 22nd", () => {
    assert.equal(days("2026-10-25T12:00:00Z"), map(...oct(19, 20, 21, 22, 23, 24, 18)));
  });
  it("every other weekday of that week", () => {
    assert.equal(days("2026-10-26T12:00:00Z"), map(...oct(19, 20, 21, 22, 23, 24, 25)), "Monday");
    assert.equal(days("2026-10-27T12:00:00Z"), map(...oct(26, 20, 21, 22, 23, 24, 25)), "Tuesday");
    assert.equal(days("2026-10-28T12:00:00Z"), map(...oct(26, 27, 21, 22, 23, 24, 25)), "Wednesday");
    assert.equal(days("2026-10-29T12:00:00Z"), map(...oct(26, 27, 28, 22, 23, 24, 25)), "Thursday");
    assert.equal(days("2026-10-30T12:00:00Z"), map(...oct(26, 27, 28, 29, 23, 24, 25)), "Friday");
    assert.equal(days("2026-10-31T12:00:00Z"), map(...oct(26, 27, 28, 29, 30, 24, 25)), "Saturday");
  });
  it("on a Thursday, last Thursday is seven days ago, never today (the meeting-request resolver's rule)", () => {
    for (const t of ["2026-10-29T00:00:01Z", "2026-10-29T12:00:00Z", "2026-10-29T23:59:59Z"]) assert.match(days(t), /Last Thursday = 22 October 2026;/, t);
    for (const [iso, name] of [["2026-10-26", "Monday"], ["2026-10-27", "Tuesday"], ["2026-10-28", "Wednesday"], ["2026-10-29", "Thursday"], ["2026-10-30", "Friday"], ["2026-10-31", "Saturday"], ["2026-11-01", "Sunday"]] as const) {
      const ms = new Date(`${iso}T12:00:00Z`).getTime();
      const d = new Date(ms - 7 * 86_400_000);
      assert.ok(weekdayDatesLine(ms, "UTC").includes(`Last ${name} = ${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]} ${d.getUTCFullYear()}`), `${name} on a ${name}: seven days back`);
    }
  });
  it("agrees with the existing meeting resolver for every weekday", async () => {
    const { parseMeetingRequest } = await import("../src/lib/ai-brain/assistant/meetings/request");
    for (const nowIso of ["2026-10-29T12:00:00Z", "2026-10-25T12:00:00Z", "2027-01-04T12:00:00Z"]) {
      const now = new Date(nowIso);
      const line = weekdayDatesLine(now.getTime(), "UTC");
      for (const name of NAMES) {
        const req = parseMeetingRequest(`summarise last ${name.toLowerCase()}'s meeting`, { now, tz: "UTC" });
        const date = req?.date;
        assert.ok(date, `${nowIso} ${name}`);
        assert.ok(line.includes(`Last ${name} = ${date.day} ${MONTHS[date.month - 1]} ${date.year}`), `${nowIso} ${name}: resolver says ${JSON.stringify(date)}`);
      }
    }
  });
  it("uses the user's time zone: Toronto and Auckland", () => {
    assert.equal(days("2026-10-26T02:00:00Z", "America/Toronto"), map(...oct(19, 20, 21, 22, 23, 24, 18)), "Toronto: still Sunday evening");
    assert.equal(days("2026-10-26T02:00:00Z", "UTC"), map(...oct(19, 20, 21, 22, 23, 24, 25)), "UTC: already Monday");
    assert.equal(days("2026-10-25T23:30:00Z", "Pacific/Auckland"), map(...oct(19, 20, 21, 22, 23, 24, 25)), "Auckland: already Monday");
    assert.equal(days("2026-10-25T23:30:00Z", "UTC"), map(...oct(19, 20, 21, 22, 23, 24, 18)), "UTC: still Sunday");
    assert.notEqual(days("2026-10-25T23:30:00Z", "Pacific/Auckland"), days("2026-10-25T23:30:00Z", "America/Toronto"));
  });
  it("crosses the December to January year boundary", () => {
    assert.equal(days("2027-01-04T12:00:00Z"), map("28 December 2026", "29 December 2026", "30 December 2026", "31 December 2026", "1 January 2027", "2 January 2027", "3 January 2027"));
    assert.equal(days("2027-01-01T12:00:00Z"), map("28 December 2026", "29 December 2026", "30 December 2026", "31 December 2026", "25 December 2026", "26 December 2026", "27 December 2026"));
  });
  it("a leap day is counted", () => {
    assert.match(days("2028-03-02T12:00:00Z"), /Last Tuesday = 29 February 2028;/);
    assert.match(days("2028-03-02T12:00:00Z"), /Last Monday = 28 February 2028;/);
  });
  it("the first model message carries the map computed from the request's clock, not the system clock", async () => {
    const { requests } = await run([READ, submit([A, B])]); // the Brain's request time is Sunday 25 October 2026
    const msg = first({ requests });
    assert.ok(msg.includes(map(...oct(19, 20, 21, 22, 23, 24, 18))), msg);
    assert.ok(msg.indexOf("Last week =") < msg.indexOf("Relative weekday dates"), "alongside the calendar weeks");
    const s = script([READ, submit([A, B])]);
    const agent = createToolAgent({ transport: s.transport, limiter: createMemoryRateLimiter({ maxCalls: 10 }), now: () => Date.parse("2030-06-15T12:00:00Z") });
    await agent.run({ ...base, nowMs: Date.parse("2026-10-25T12:00:00Z"), timeZone: "UTC" });
    assert.ok(first(s).includes("Last Thursday = 22 October 2026"));
    assert.ok(!/2030|June/.test(first(s)), "the agent's own clock is never used");
  });
  it("without the request's clock no dates are stated; an unknown time zone falls back to UTC", async () => {
    const none = script([READ, submit([A])]);
    await createToolAgent({ transport: none.transport, limiter: createMemoryRateLimiter({ maxCalls: 10 }) }).run({ ...base, timeZone: "UTC" });
    assert.ok(!/Relative weekday dates|Calendar weeks/.test(first(none)));
    const nan = script([READ, submit([A])]);
    await createToolAgent({ transport: nan.transport, limiter: createMemoryRateLimiter({ maxCalls: 10 }) }).run({ ...base, nowMs: Number.NaN, timeZone: "UTC" });
    assert.ok(!/Relative weekday dates/.test(first(nan)));
    const bad = script([READ, submit([A])]);
    await createToolAgent({ transport: bad.transport, limiter: createMemoryRateLimiter({ maxCalls: 10 }) }).run({ ...base, nowMs: Date.parse("2026-10-26T02:00:00Z"), timeZone: "Not/AZone" });
    assert.ok(first(bad).includes(map(...oct(19, 20, 21, 22, 23, 24, 25))), "UTC: Monday 26 October");
  });
  it("the prompt tells the model to use the map and never calculate or invent dates", () => {
    assert.match(AGENT_SYSTEM_PROMPT, /"Relative weekday dates" exactly/);
    assert.match(AGENT_SYSTEM_PROMPT, /never calculate a weekday date yourself and never invent a meeting date/);
  });
});
