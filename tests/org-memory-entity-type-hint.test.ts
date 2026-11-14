import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { memoryTools, type MemoryFindNative } from "../src/lib/ai-brain/assistant/memory-tools";
import { standardRegistry, unavailableConnectors, type NotionConnector } from "../src/lib/ai-brain/assistant";
import { AGENT_SYSTEM_PROMPT, MAX_CALLS, MAX_ROUNDS, MEMORY_PROMPT, createToolAgent, searchNote } from "../src/lib/ai-brain/chat/tool-agent";
import { createMemoryRateLimiter } from "../src/lib/ai-brain/chat";
import type { ToolTransport, ToolTurn, ToolTurnRequest } from "../src/lib/ai-brain/model-tool-transport";
import { createMemoryOrgStore, type Extractor } from "../src/lib/ai-brain/org-memory";
import type { EntityQuery, OrgMemoryAccess } from "../src/lib/ai-brain/org-memory/types";
import { handleChat } from "../src/lib/chat-service";
import { handleIngest } from "../src/lib/org-memory-service";
import type { Repo } from "../src/lib/backend/types";
import type { Profile } from "../src/lib/types";
import { NOW, admin, fakeRepo } from "./ai-chat-helpers";

/**
 * K1/K2 root-cause fix (local only, no Supabase): entity_type is a HINT. A typed search that finds nothing is repeated once without the type (only when there
 * is a query, never after an error), the result says so and carries each record's own type; archived / rejected / stale handling is untouched; stored-notes
 * questions start with memory search while meeting questions keep the Notion meeting tools; the call budget is unchanged.
 */

const PAGE = { title: "Halcyon logistics", edited: "2026-11-01T11:00:00.000Z", lines: ["Dana from the Operations team will confirm the warehouse slot."] };
function notion(lines: string[] = PAGE.lines, edited = PAGE.edited): NotionConnector {
  return {
    ...unavailableConnectors().notion,
    async findMeetingCandidates() { return { ok: true, data: [{ system: "notion", record_id: "p1", title: PAGE.title, url: "https://www.notion.so/p1", last_edited: edited, date_only: false, date_source: "none", retrieved_at: NOW.toISOString() } as never] }; },
    async readMeetingDocument(id) {
      const segments = [PAGE.title, ...lines].map((t, i) => ({ id: `S${i + 1}`, ref: `b${i}`, kind: i === 0 ? "title" as const : "text" as const, text: t, depth: 0 }));
      return { ok: true, data: { system: "notion", record_id: id, title: PAGE.title, url: "https://www.notion.so/p1", last_edited: edited, date_only: false, date_source: "none", retrieved_at: NOW.toISOString(), segments, coverage: { complete: true, gaps: [], blocks_read: segments.length } } as never };
    },
  };
}
const extractorOf = (name: string): Extractor => ({ async extract() { return { ok: true, raw: [{ entity_type: "task", name, description: `Dana confirms: ${name}.`, evidence: ["S2"], basis: "explicit", confidence: "high", owner: "Dana", team: "Operations" }], truncated: false }; } });

async function world(name = "Confirm warehouse slot") {
  const store = createMemoryOrgStore(() => NOW);
  const repoFor = (u: Profile) => async (): Promise<Repo> => ({ ...fakeRepo({}).repo, orgMemory: store.accessFor(u) });
  const ingest = (extractor: Extractor, lines?: string[], edited?: string) => handleIngest({ user: admin, backendKind: "supabase", repoFor: repoFor(admin), notion: notion(lines, edited), extractor, workspaceId: "ws", now: () => NOW, log: () => undefined });
  assert.equal((await ingest(extractorOf(name))).ok, true);
  return { store, repoFor, ingest };
}

/** Runs memory.entities.find against the real in-memory reader, recording every adapter call (the arguments it received). */
function finder(access: OrgMemoryAccess, opts: { failFirst?: boolean } = {}) {
  const calls: EntityQuery[] = [];
  const reader: OrgMemoryAccess["reader"] = { ...access.reader, async findEntities(q) { calls.push({ ...q }); if (opts.failFirst) throw new Error("database exploded"); return access.reader.findEntities(q); } };
  const tool = memoryTools().find((t) => t.id === "memory.entities.find")!;
  const run = (input: unknown) => tool.run!(tool.input.parse(input), { user: admin, now: NOW, brain: { user: admin, repo: fakeRepo({}).repo, mode: "live", now: NOW, orgMemory: reader } as never, connectors: unavailableConnectors() });
  return { calls, run };
}
const nativeOf = (r: Awaited<ReturnType<ReturnType<typeof finder>["run"]>>) => (r.ok ? (r.native as MemoryFindNative) : null);

describe("memory.entities.find: entity_type is a hint", () => {
  it("a correctly typed search returns the typed result with no fallback (one adapter call)", async () => {
    const w = await world();
    const f = finder(w.store.accessFor(admin));
    const n = nativeOf(await f.run({ query: "warehouse", entity_type: "task" }));
    assert.equal(n?.entities.length, 1);
    assert.equal(n?.untyped_fallback, undefined);
    assert.equal(f.calls.length, 1);
    assert.equal(f.calls[0]!.entity_type, "task");
  });
  it("a wrong typed search (as the live run did: commitment, decision, meeting) falls back to untyped and finds the task", async () => {
    const w = await world();
    for (const wrong of ["commitment", "decision", "meeting"]) {
      const f = finder(w.store.accessFor(admin));
      const r = await f.run({ query: "warehouse", entity_type: wrong });
      const n = nativeOf(r);
      assert.equal(n?.entities.length, 1, wrong);
      assert.equal(n?.entities[0]!.entity_type, "task", "the record's actual type is returned");
      assert.equal(n?.untyped_fallback, true);
      assert.equal(f.calls.length, 2, "typed search, then exactly one untyped retry");
      assert.equal(f.calls[0]!.entity_type, wrong);
      assert.equal(f.calls[1]!.entity_type, undefined, "the retry has no type");
      assert.equal(f.calls[1]!.query, "warehouse", "the same query");
      assert.equal(f.calls[1]!.limit, f.calls[0]!.limit, "the same limit");
      assert.match(r.ok ? r.data[0]!.title : "", /^task: Confirm warehouse slot/);
    }
  });
  it("no fallback without a query (a type-only listing stays typed), and none when the typed search found something", async () => {
    const w = await world();
    const f = finder(w.store.accessFor(admin));
    const n = nativeOf(await f.run({ entity_type: "commitment" }));
    assert.equal(n?.entities.length, 0);
    assert.equal(n?.untyped_fallback, undefined);
    assert.equal(f.calls.length, 1);
  });
  it("an adapter error is not retried: the call fails once, with no second adapter call", async () => {
    const w = await world();
    const f = finder(w.store.accessFor(admin), { failFirst: true });
    const r = await f.run({ query: "warehouse", entity_type: "commitment" }).then((x) => x, (e) => ({ thrown: e as Error }));
    assert.ok("thrown" in r, "the error propagates to runTool, which turns it into a fixed failure");
    assert.equal(f.calls.length, 1);
  });
  it("authorization is unchanged: a member's reader returns nothing, typed or not, and the fallback finds nothing either", async () => {
    const w = await world();
    const member = { id: "m", role: "member" };
    const f = finder(w.store.accessFor(member));
    const n = nativeOf(await f.run({ query: "warehouse", entity_type: "commitment" }));
    assert.equal(n?.entities.length, 0);
  });
  it("rejected records stay excluded from both the typed search and the fallback", async () => {
    const w = await world();
    const id = w.store.snapshot().entities[0]!.id;
    await w.store.accessFor(admin).reader.review(id, "reject", null);
    const f = finder(w.store.accessFor(admin));
    const n = nativeOf(await f.run({ query: "warehouse", entity_type: "commitment" }));
    assert.equal(n?.entities.length, 0);
    assert.equal(f.calls.length, 2);
  });
  it("records of an archived source stay excluded from both searches", async () => {
    const w = await world();
    const doc = w.store.snapshot().docs[0]!;
    await w.store.accessFor(admin).writer.archiveDoc("notion", doc.workspace_id, doc.source_id);
    const f = finder(w.store.accessFor(admin));
    const n = nativeOf(await f.run({ query: "warehouse", entity_type: "commitment" }));
    assert.equal(n?.entities.length, 0);
    assert.equal(n?.docs.length, 0);
  });
});

describe("the agent: what Claude is shown", () => {
  const call = (name: string, input: unknown, id = "tu_1"): ToolTurn => ({ blocks: [{ type: "tool_use", id, name, input }], stopReason: "tool_use", usage: { input: 1, output: 1 } });
  const submit = (items: unknown): ToolTurn => ({ blocks: [{ type: "tool_use", id: "sub", name: "submit_answer", input: { items } }], stopReason: "tool_use", usage: { input: 1, output: 1 } });
  function agent(turns: ToolTurn[]) {
    const requests: ToolTurnRequest[] = [];
    let i = 0;
    const transport: ToolTransport = async (r) => { requests.push(JSON.parse(JSON.stringify(r)) as ToolTurnRequest); return turns[Math.min(i++, turns.length - 1)]!; };
    return { toolAgent: createToolAgent({ transport, limiter: createMemoryRateLimiter({ maxCalls: 50 }) }), requests };
  }
  const Q = "what do our stored notes say about the Halcyon warehouse slot";
  const chat = (w: Awaited<ReturnType<typeof world>>, turns: ToolTurn[]) => {
    const a = agent(turns);
    return { a, run: handleChat({ user: admin, backendKind: "supabase", repoFor: w.repoFor(admin), toolAgent: a.toolAgent, now: () => NOW, timeZone: "UTC" }, Q) };
  };

  it("the fallback is announced, the record's own type is delivered, and the cited answer is accepted end to end", async () => {
    const w = await world();
    const c = chat(w, [call("memory_entities_find", { query: "warehouse", entity_type: "commitment" }), submit([{ text: "Dana, in Operations, is to confirm the warehouse slot (proposed, not yet reviewed).", cites: ["M1.S2"] }])]);
    const r = await c.run;
    assert.equal(r.ok, true);
    const delivered = JSON.stringify(c.a.requests[1]!.messages);
    assert.match(delivered, /untyped_fallback/);
    assert.match(delivered, /repeated WITHOUT the type/);
    assert.match(delivered, /\\"type\\":\\"task\\"/, "the actual entity type travels with the record");
    assert.match(delivered, /M1\.S2/);
    if (r.ok) assert.match(JSON.stringify(r.reply.sections), /Halcyon logistics.*"cite":\["S2"\]/, "the cited stored page is shown");
  });
  it("a typed search that matches carries no fallback note", async () => {
    const w = await world();
    const c = chat(w, [call("memory_entities_find", { query: "warehouse", entity_type: "task" }), submit([{ text: "Dana is to confirm the warehouse slot (proposed, not yet reviewed).", cites: ["M1.S2"] }])]);
    await c.run;
    assert.ok(!/untyped_fallback|repeated WITHOUT/.test(JSON.stringify(c.a.requests[1]!.messages)));
  });
  it("a stale record is delivered as source_changed with no citations, never as current verified evidence", async () => {
    const w = await world("Confirm warehouse slot");
    // the page changes and no longer says it: the first record is marked stale
    await w.ingest({ async extract() { return { ok: true, raw: [{ entity_type: "task", name: "Ship the pallets", description: "Ship the pallets.", evidence: ["S2"], basis: "explicit", confidence: "high" }], truncated: false }; } }, ["Ops will ship the pallets on Monday."], "2026-11-02T09:00:00.000Z");
    const stale = w.store.snapshot().entities.find((e) => e.name === "Confirm warehouse slot");
    assert.equal(stale?.stale, true, "precondition: the old record is stale");
    const c = chat(w, [call("memory_entities_find", { query: "warehouse", entity_type: "commitment" }), submit([{ text: "Dana is to confirm the warehouse slot.", cites: ["M1.S2"] }])]);
    const r = await c.run;
    const delivered = JSON.stringify(c.a.requests[1]!.messages);
    assert.match(delivered, /source_changed/);
    assert.match(delivered, /\\"cites\\":\[\]/, "a stale record has no citable segments");
    assert.ok(r.ok && !/confirm the warehouse slot/i.test(r.reply.text), "the unsupported statement about a stale record is not shown as fact");
  });
  it("an empty result no longer tells the model that nothing exists, and the hint says the type is only a hint", () => {
    const h = searchNote(0, undefined).hint ?? "";
    assert.match(h, /No stored record matched\. Try one distinctive keyword/);
    assert.match(h, /does not mean the organization has no such knowledge/);
    assert.match(h, /only a hint/);
    assert.match(searchNote(0, undefined, true).hint ?? "", /repeated WITHOUT the type[\s\S]*No stored record matched/);
    assert.deepEqual(searchNote(2, undefined), {});
  });
  it("the tool description and schema call the type an optional hint", async () => {
    const t = memoryTools().find((x) => x.id === "memory.entities.find")!;
    assert.match(t.description, /`entity_type` is only a hint/);
    assert.match(t.description, /does not by itself mean the organization has no such knowledge/);
    const c = chat(await world(), [call("memory_entities_find", { query: "warehouse" }), submit([{ text: "x", cites: [] }])]);
    await c.run;
    const def = c.a.requests[0]!.tools.find((x) => x.name === "memory_entities_find")!;
    assert.match(JSON.stringify(def.input_schema), /Optional HINT, not a guaranteed classification/);
  });

  it("tool selection: for a stored-notes question the memory prompt says memory search comes first and meetings are not a default first step", async () => {
    assert.match(MEMORY_PROMPT, /Choosing the first tool[\s\S]*start with memory_entities_find/);
    assert.match(MEMORY_PROMPT, /Call notion_meetings_find only when the user refers to a particular meeting or time/);
    assert.match(MEMORY_PROMPT, /Never call notion_meetings_find first just to look around/);
    const w = await world();
    const c = chat(w, [call("memory_entities_find", { query: "warehouse" }), submit([{ text: "Dana is to confirm the warehouse slot (proposed, not yet reviewed).", cites: ["M1.S2"] }])]);
    await c.run;
    const sys = c.a.requests[0]!.system;
    assert.ok(sys.includes(AGENT_SYSTEM_PROMPT) && sys.includes(MEMORY_PROMPT), "an administrator gets the meeting prompt PLUS the memory prompt");
    assert.ok(c.a.requests[0]!.tools.some((t) => t.name === "notion_meetings_find") && c.a.requests[0]!.tools.some((t) => t.name === "memory_entities_find"));
  });
  it("meeting-specific questions keep Notion meeting search: the meeting rules are unchanged and the meeting tools still work through the agent", async () => {
    assert.match(AGENT_SYSTEM_PROMPT, /To answer about a meeting: call notion_meetings_find with a few keywords/);
    // without memory tools offered, the prompt is exactly the original meeting prompt
    const sent: string[] = [];
    const transport: ToolTransport = async (r) => { sent.push(r.system); return submit([{ text: "x", cites: [] }]); };
    const meetingsOnly = standardRegistry().list().filter((c) => c.id.startsWith("notion.meetings"));
    await createToolAgent({ transport, limiter: createMemoryRateLimiter({ maxCalls: 5 }) }).run({ userId: "u", role: "admin", message: "what did we decide in yesterday's meeting", today: "Tuesday 3 November 2026", timeZone: "UTC", recent: [], contracts: meetingsOnly, run: async () => ({ ok: false, tool: "x", reason: "error", detail: "n/a" }) });
    assert.equal(sent[0], AGENT_SYSTEM_PROMPT);
    // and a meeting question still runs the meeting tools, in order
    const ran: string[] = [];
    const turns = [call("notion_meetings_find", { keywords: ["weekly"] }), call("notion_meetings_read", { record_id: "p1" }), submit([{ text: "The page is titled Halcyon logistics.", cites: ["M1.S1"] }])];
    let i = 0;
    const outcome = await createToolAgent({ transport: async () => turns[i++]!, limiter: createMemoryRateLimiter({ maxCalls: 5 }) }).run({
      userId: "u", role: "admin", message: "what did we decide in yesterday's meeting", today: "Tuesday 3 November 2026", timeZone: "UTC", recent: [], contracts: meetingsOnly,
      run: async (id) => {
        ran.push(id);
        const n = notion();
        if (id === "notion.meetings.find") { const f = await n.findMeetingCandidates({ keywords: [], limit: 5 } as never, {} as never); return { ok: true, tool: id, records: [], retrieved_at: NOW.toISOString(), native: f.ok ? f.data : [] }; }
        const d = await n.readMeetingDocument("p1");
        return { ok: true, tool: id, records: [], retrieved_at: NOW.toISOString(), native: d.ok ? d.data : undefined };
      },
    });
    assert.deepEqual(ran, ["notion.meetings.find", "notion.meetings.read"]);
    assert.equal(outcome.kind, "answered");
  });
  it("the tool-call budget is unchanged (3 rounds, 4 calls), and a fifth call still declines with 'limit'", async () => {
    assert.equal(MAX_ROUNDS, 3);
    assert.equal(MAX_CALLS, 4);
    const w = await world();
    const one = (n: number) => call("memory_entities_find", { query: `warehouse${n}` }, `tu_${n}`);
    const many: ToolTurn = { blocks: [1, 2, 3, 4, 5].map((n) => ({ type: "tool_use" as const, id: `t${n}`, name: "memory_entities_find", input: { query: `word${n}` } })), stopReason: "tool_use", usage: { input: 1, output: 1 } };
    const c = chat(w, [many, one(9), submit([{ text: "x", cites: [] }])]);
    await c.run;
    assert.equal(c.a.requests.length, 1, "five parallel calls in one round exceed the 4-call budget and stop the agent");
  });
});
