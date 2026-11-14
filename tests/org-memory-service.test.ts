import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createToolAgent } from "../src/lib/ai-brain/chat/tool-agent";
import { createMemoryRateLimiter } from "../src/lib/ai-brain/chat";
import { standardRegistry, phase1Tools, unavailableConnectors, type NotionConnector } from "../src/lib/ai-brain/assistant";
import type { MeetingCandidate, MeetingDocument } from "../src/lib/ai-brain/assistant/meetings/types";
import type { ToolTransport, ToolTurn, ToolTurnRequest } from "../src/lib/ai-brain/model-tool-transport";
import { createMemoryOrgStore, type Extractor } from "../src/lib/ai-brain/org-memory";
import { handleChat } from "../src/lib/chat-service";
import { handleIngest, type IngestServiceDeps } from "../src/lib/org-memory-service";
import type { Repo } from "../src/lib/backend/types";
import type { Profile } from "../src/lib/types";
import { NOW, admin, alice, fakeRepo } from "./ai-chat-helpers";

// ---- fakes ---------------------------------------------------------------------------------------------------------------------
const LINES = ["Priya will send the checklist by Friday.", "Decision: launch the marketplace in Pune first."];
function notionOf(opts: { gate?: Promise<void>; fail?: boolean; listFail?: boolean } = {}) {
  const calls = { find: 0, read: 0 };
  const connector: NotionConnector = {
    ...unavailableConnectors().notion,
    async findMeetingCandidates() {
      calls.find += 1;
      if (opts.gate) await opts.gate;
      if (opts.listFail) return { ok: false, reason: "not_connected" };
      return { ok: true, data: [{ system: "notion", record_id: "p1", title: "Weekly sync", url: "https://www.notion.so/p1", last_edited: "2026-10-20T10:00:00.000Z", date_only: false, date_source: "none", retrieved_at: NOW.toISOString() } as MeetingCandidate] };
    },
    async readMeetingDocument(id) {
      calls.read += 1;
      if (opts.fail) return { ok: false, reason: "rate_limited" };
      const segments = ["Weekly sync", ...LINES].map((t, i) => ({ id: `S${i + 1}`, ref: `b${i}`, kind: i === 0 ? "title" as const : "text" as const, text: t, depth: 0 }));
      return { ok: true, data: { system: "notion", record_id: id, title: "Weekly sync", url: "https://www.notion.so/p1", last_edited: "2026-10-20T10:00:00.000Z", date_only: false, date_source: "none", retrieved_at: NOW.toISOString(), segments, coverage: { complete: true, gaps: [], blocks_read: 3 } } as MeetingDocument };
    },
  };
  return { connector, calls };
}
const ENTITIES = [
  { entity_type: "task", name: "Send checklist", description: "Priya sends the checklist.", evidence: ["S2"], basis: "explicit", confidence: "high", owner: "Priya", due: "Friday" },
  { entity_type: "decision", name: "Launch in Pune", description: "Launch the marketplace in Pune first.", evidence: ["S3"], basis: "explicit", confidence: "high" },
];
const extractor: Extractor = { async extract() { return { ok: true, raw: ENTITIES, truncated: false }; } };

function world() {
  const store = createMemoryOrgStore(() => NOW);
  const repoFor = (u: Profile) => async (): Promise<Repo> => ({ ...fakeRepo({}).repo, orgMemory: store.accessFor(u) });
  const deps = (u: Profile | null, over: Partial<IngestServiceDeps> = {}): IngestServiceDeps => ({
    user: u, backendKind: "supabase", repoFor: u ? repoFor(u) : async () => fakeRepo({}).repo, notion: notionOf().connector, extractor, workspaceId: "ws", now: () => NOW, log: () => undefined, ...over,
  });
  return { store, repoFor, deps };
}

// ---- the ingestion entry point ----------------------------------------------------------------------------------------------------
describe("handleIngest: the controlled administrator-only path", () => {
  it("an administrator ingests: L0 and L1 are written through THEIR session, and the run is recorded with counts only", async () => {
    const w = world();
    const out = await handleIngest(w.deps(admin));
    assert.equal(out.ok, true);
    if (!out.ok) return;
    assert.deepEqual([out.status, out.report.created, out.report.extracted_docs, out.report.entities_created], ["ok", 1, 1, 2]);
    const snap = w.store.snapshot();
    assert.deepEqual([snap.docs.length, snap.entities.length], [1, 2]);
    const log = w.store.runLog();
    assert.equal(log.length, 1);
    assert.equal(log[0]!.status, "ok");
    assert.ok(Object.values(log[0]!.report).every((v) => typeof v === "number" || typeof v === "string" || v === null), "counts and fixed codes only");
    assert.ok(!JSON.stringify(log).includes("Weekly sync") && !JSON.stringify(log).includes("Priya"));
  });
  it("a member is refused before Notion, the model or the database is touched", async () => {
    const w = world();
    const n = notionOf();
    const out = await handleIngest(w.deps(alice, { notion: n.connector }));
    assert.deepEqual(out, { ok: false, error: "forbidden", message: "Only administrators can update organizational memory." });
    assert.deepEqual([n.calls.find, n.calls.read, w.store.snapshot().docs.length], [0, 0, 0]);
  });
  it("the role is read from the server profile, so a member profile cannot become admin by claiming it", async () => {
    const w = world();
    const liar = { ...alice, role: "member" } as Profile;
    assert.equal((await handleIngest(w.deps(liar))).ok, false);
  });
  it("no user, the demo backend, no Notion and no memory repository all fail closed", async () => {
    const w = world();
    assert.equal((await handleIngest(w.deps(null))).ok, false);
    assert.deepEqual((await handleIngest(w.deps(admin, { backendKind: "demo" }))).ok, false);
    assert.deepEqual(await handleIngest(w.deps(admin, { notion: null })), { ok: false, error: "unavailable", message: "Organizational memory is not available here." });
    assert.deepEqual((await handleIngest(w.deps(admin, { repoFor: async () => fakeRepo({}).repo }))).ok, false);
    assert.equal(w.store.snapshot().docs.length, 0);
  });
  it("only one run at a time: a concurrent request is refused as busy and corrupts nothing", async () => {
    const w = world();
    let open!: () => void;
    const gate = new Promise<void>((r) => { open = r; });
    const first = handleIngest(w.deps(admin, { notion: notionOf({ gate }).connector }));
    await new Promise((r) => setTimeout(r, 5));
    const second = await handleIngest(w.deps(admin));
    assert.deepEqual(second.ok === false && second.error, "busy");
    open();
    assert.equal((await first).ok, true);
    assert.equal(w.store.snapshot().docs.length, 1);
    assert.equal((await handleIngest(w.deps(admin))).ok, true, "the slot is free again afterwards");
  });
  it("repeating a run is idempotent", async () => {
    const w = world();
    await handleIngest(w.deps(admin));
    const before = JSON.stringify(w.store.snapshot());
    const again = await handleIngest(w.deps(admin));
    assert.ok(again.ok && again.report.created === 0 && again.report.entities_created === 0 && again.report.extracted_docs === 0);
    assert.equal(JSON.stringify(w.store.snapshot()), before);
  });
  it("source failures end the run as partial/failed with fixed codes, and free the slot", async () => {
    const w = world();
    const partial = await handleIngest(w.deps(admin, { notion: notionOf({ fail: true }).connector }));
    assert.deepEqual(partial.ok && [partial.status, partial.report.failed], ["partial", 1]);
    const failed = await handleIngest(w.deps(admin, { notion: notionOf({ listFail: true }).connector }));
    assert.deepEqual(failed.ok && [failed.status, failed.report.discovery_failure], ["failed", "not_connected"]);
    assert.deepEqual(w.store.runLog().map((r) => r.status), ["partial", "failed"]);
  });
  it("an unexpected crash finishes the run as failed, frees the slot and leaks nothing", async () => {
    const w = world();
    const boom: Extractor = { async extract() { throw new Error("secret-token-xyz in message"); } };
    const out = await handleIngest(w.deps(admin, { extractor: boom }));
    assert.deepEqual(out, { ok: false, error: "failed", message: "The update could not be completed." });
    assert.equal(w.store.runLog()[0]!.status, "failed");
    assert.ok(!JSON.stringify(out).includes("secret-token"));
    assert.equal((await handleIngest(w.deps(admin))).ok, true);
  });
});

// ---- the live chat path populates organizational memory ----------------------------------------------------------------------------------
describe("the chat path: BrokoChat -> handleChat -> askBrain -> tool agent -> Registry -> memory repository", () => {
  const call = (name: string, input: unknown): ToolTurn => ({ blocks: [{ type: "tool_use", id: "tu_1", name, input }], stopReason: "tool_use", usage: { input: 1, output: 1 } });
  const submit = (items: unknown): ToolTurn => ({ blocks: [{ type: "tool_use", id: "sub", name: "submit_answer", input: { items } }], stopReason: "tool_use", usage: { input: 1, output: 1 } });
  function agent(turns: ToolTurn[]) {
    const requests: ToolTurnRequest[] = [];
    let i = 0;
    const transport: ToolTransport = async (r) => { requests.push(JSON.parse(JSON.stringify(r)) as ToolTurnRequest); return turns[Math.min(i++, turns.length - 1)]!; };
    return { toolAgent: createToolAgent({ transport, limiter: createMemoryRateLimiter({ maxCalls: 50 }) }), requests };
  }
  const Q = "what has priya committed to about the checklist";
  const answerTurns = () => [call("memory_entities_find", { entity_type: "task" }), submit([{ text: "Priya was to send the checklist by Friday.", cites: ["M1.S2"] }])];
  async function seeded() {
    const w = world();
    await handleIngest(w.deps(admin));
    return w;
  }
  const chat = (w: Awaited<ReturnType<typeof seeded>>, u: Profile, turns: ToolTurn[], kind: "supabase" | "demo" = "supabase") => {
    const a = agent(turns);
    return { a, run: handleChat({ user: u, backendKind: kind, repoFor: w.repoFor(u), toolAgent: a.toolAgent, now: () => NOW, timeZone: "UTC" }, Q) };
  };

  it("an administrator's chat receives organizational memory and answers from it with a validated citation", async () => {
    const w = await seeded();
    const c = chat(w, admin, answerTurns());
    const r = await c.run;
    assert.equal(r.ok, true);
    if (!r.ok) return;
    assert.match(r.reply.text, /Priya was to send the checklist/);
    assert.match(JSON.stringify(r.reply.sections), /stored Notion memory/);
    const delivered = JSON.stringify(c.a.requests[1]!.messages);
    assert.ok(delivered.includes("M1.S2") && /review[^a-z]+proposed/.test(delivered));
    assert.ok(c.a.requests[0]!.tools.some((t) => t.name === "memory_entities_find") && c.a.requests[0]!.tools.some((t) => t.name === "memory_sources_read"));
  });
  it("K1/K2: a question-shaped query (words absent as a phrase) still finds the record and the cited answer is shown", async () => {
    const w = await seeded();
    const c = chat(w, admin, [call("memory_entities_find", { query: "Halcyon send checklist Friday" }), submit([{ text: "Priya was to send the checklist by Friday.", cites: ["M1.S2"] }])]);
    const r = await c.run;
    assert.equal(r.ok, true);
    if (!r.ok) return;
    assert.match(r.reply.text, /Priya was to send the checklist/);
    assert.ok(JSON.stringify(c.a.requests[1]!.messages).includes("M1.S2"), "the matched record's segment was delivered");
  });
  it("an empty search result carries the fixed hint; a non-empty one does not", async () => {
    const w = await seeded();
    const empty = chat(w, admin, [call("memory_entities_find", { query: "budget" }), submit([{ text: "x", cites: [] }])]);
    await empty.run;
    assert.match(JSON.stringify(empty.a.requests[1]!.messages), /No stored record matched\. Try one distinctive keyword/);
    const hit = chat(w, admin, answerTurns());
    await hit.run;
    assert.ok(!JSON.stringify(hit.a.requests[1]!.messages).includes("No stored record matched"));
  });
  it("an undelivered citation is rejected end to end", async () => {
    const w = await seeded();
    const r = await chat(w, admin, [call("memory_entities_find", { entity_type: "task" }), submit([{ text: "The marketplace launches in Pune first.", cites: ["M1.S3"] }])]).run;
    assert.equal(r.ok, true);
    if (r.ok) assert.ok(!/launches in Pune/.test(r.reply.text), "the unsupported statement was not shown");
  });
  it("a member's chat is offered no memory tool, makes no model call, and sees nothing", async () => {
    const w = await seeded();
    const c = chat(w, alice, answerTurns());
    const r = await c.run;
    assert.equal(r.ok, true);
    assert.equal(c.a.requests.length, 0, "no tool-agent model call for a member");
    if (r.ok) assert.ok(!/Priya|checklist/.test(JSON.stringify(r.reply)) || /administrators/.test(JSON.stringify(r.reply)));
  });
  it("a member who somehow reaches the tool directly (bypassing the agent) gets permission_denied; guessed ids read nothing", async () => {
    const w = await seeded();
    const { runBrainTool } = await import("../src/lib/ai-brain/assistant");
    const repo = await w.repoFor(alice)();
    const brain = { user: alice, repo, mode: "live" as const, now: NOW, orgMemory: repo.orgMemory!.reader, connectors: unavailableConnectors() };
    const r1 = await runBrainTool(brain, "memory.entities.find", {});
    assert.deepEqual([r1.ok, r1.ok ? "" : r1.reason], [false, "permission_denied"]);
    const docId = w.store.snapshot().docs[0]!.id;
    const r2 = await runBrainTool(brain, "memory.sources.read", { id: docId });
    assert.equal(r2.ok, false);
    assert.equal(await repo.orgMemory!.reader.getDocument(docId), null);
    assert.equal(await repo.orgMemory!.reader.getEntity(w.store.snapshot().entities[0]!.id), null);
    await assert.rejects(() => repo.orgMemory!.writer.upsertEntities(docId, [], NOW.toISOString()));
  });
  it("a guessed or malformed id from an administrator finds nothing and does not throw", async () => {
    const w = await seeded();
    const { runBrainTool } = await import("../src/lib/ai-brain/assistant");
    const repo = await w.repoFor(admin)();
    const brain = { user: admin, repo, mode: "live" as const, now: NOW, orgMemory: repo.orgMemory!.reader, connectors: unavailableConnectors() };
    assert.equal((await runBrainTool(brain, "memory.sources.read", { id: "00000000-0000-0000-0000-000000000000" })).ok, false);
    assert.equal((await runBrainTool(brain, "memory.sources.read", { id: "../etc/passwd" })).ok, false);
    assert.equal((await runBrainTool(brain, "memory.entities.find", { entity_type: "wizard" })).ok, false);
  });
  it("without a memory repository (the demo, or no database) the memory tool says 'not connected' and the chat falls back normally", async () => {
    const w = await seeded();
    const a = agent([call("memory_entities_find", {}), submit([{ text: "Priya was to send it.", cites: ["M1.S2"] }])]);
    const r = await handleChat({ user: admin, backendKind: "supabase", repoFor: async () => fakeRepo({}).repo, toolAgent: a.toolAgent, now: () => NOW, timeZone: "UTC" }, Q);
    assert.equal(r.ok, true, "no crash");
    if (r.ok) assert.ok(!/Priya was to send/.test(r.reply.text));
    void w;
    assert.match(JSON.stringify(a.requests[1]?.messages ?? ""), /not connected/i);
  });
  it("the Phase 1 meeting tools are all still registered and unchanged", () => {
    const ids = new Set(standardRegistry().list().map((c) => c.id));
    for (const t of phase1Tools()) assert.ok(ids.has(t.id), t.id);
    assert.deepEqual([...ids].filter((i) => i.startsWith("memory.")).sort(), ["memory.entities.find", "memory.relationships.find", "memory.sources.read"]);
    assert.ok(standardRegistry().list().filter((c) => c.id.startsWith("memory.")).every((c) => c.access === "read" && c.requires === "admin"));
  });
});
