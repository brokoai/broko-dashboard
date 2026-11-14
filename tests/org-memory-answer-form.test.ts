import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { runBrainTool, standardRegistry, unavailableConnectors } from "../src/lib/ai-brain/assistant";
import { createMemoryRateLimiter } from "../src/lib/ai-brain/chat";
import { MAX_CALLS, MAX_ROUNDS, MEMORY_PROMPT, createToolAgent, isCoverageStatement } from "../src/lib/ai-brain/chat/tool-agent";
import type { ToolTransport, ToolTurn } from "../src/lib/ai-brain/model-tool-transport";
import { createMemoryOrgStore, type Extractor } from "../src/lib/ai-brain/org-memory";
import { handleIngest } from "../src/lib/org-memory-service";
import { NOW, admin, fakeRepo } from "./ai-chat-helpers";

/**
 * K1/K2 prompt-only correction (local only, no Supabase). The live run showed a correct cited item voided because a second, uncited factual item (the review
 * status or an absence claim) rode along: validation is all-or-nothing, so the prompt now tells the model to put the status inside the cited sentence and to
 * state absence only in the coverage form. The validator itself is unchanged, and these tests pin that: the prescribed shapes pass, the old shapes still fail.
 */

const cited = "Dana from the Operations team will confirm the warehouse slot.";
const extractor: Extractor = { async extract() { return { ok: true, raw: [{ entity_type: "task", name: "Confirm warehouse slot", description: "Dana confirms the warehouse slot.", evidence: ["S2"], basis: "explicit", confidence: "high", owner: "Dana", team: "Operations" }], truncated: false }; } };
const notion = { ...unavailableConnectors().notion,
  async findMeetingCandidates() { return { ok: true, data: [{ system: "notion", record_id: "p1", title: "Halcyon logistics", url: "https://www.notion.so/p1", last_edited: "2026-11-01T11:00:00.000Z", date_only: false, date_source: "none", retrieved_at: NOW.toISOString() } as never] }; },
  async readMeetingDocument(id: string) {
    const segments = ["Halcyon logistics", cited].map((t, i) => ({ id: `S${i + 1}`, ref: `b${i}`, kind: i === 0 ? "title" as const : "text" as const, text: t, depth: 0 }));
    return { ok: true, data: { system: "notion", record_id: id, title: "Halcyon logistics", url: "https://www.notion.so/p1", last_edited: "2026-11-01T11:00:00.000Z", date_only: false, date_source: "none", retrieved_at: NOW.toISOString(), segments, coverage: { complete: true, gaps: [], blocks_read: 2 } } as never };
  } };
const item = (text: string, cites: string[]) => ({ text, cites });

/** The live call sequence (search finds the record, a second search finds nothing), then the given final submission. */
async function verdict(items: unknown[]): Promise<string> {
  const store = createMemoryOrgStore(() => NOW);
  const repoFor = async () => ({ ...fakeRepo({}).repo, orgMemory: store.accessFor(admin) });
  await handleIngest({ user: admin, backendKind: "supabase", repoFor, notion: notion as never, extractor, workspaceId: "ws", now: () => NOW, log: () => undefined });
  const repo = await repoFor();
  const brain = { user: admin, repo, mode: "live" as const, now: NOW, orgMemory: repo.orgMemory.reader, connectors: unavailableConnectors() };
  const turn = (name: string, input: unknown): ToolTurn => ({ blocks: [{ type: "tool_use", id: `${name}-${Math.random()}`, name, input }], stopReason: "tool_use", usage: { input: 1, output: 1 } });
  const turns = [turn("memory_entities_find", { query: "Halcyon warehouse slot" }), turn("memory_entities_find", { query: "Halcyon" }), turn("submit_answer", { items })];
  let n = 0;
  const transport: ToolTransport = async () => turns[n++]!;
  const out = await createToolAgent({ transport, limiter: createMemoryRateLimiter({ maxCalls: 9 }) }).run({
    userId: "u", role: "admin", message: "what do our stored notes say about the Halcyon warehouse slot", today: "Thursday 12 November 2026", timeZone: "UTC", recent: [],
    contracts: standardRegistry().list(), run: (id, input) => runBrainTool(brain as never, id, input),
  });
  return out.kind === "answered" ? "answered" : `declined:${out.reason}`;
}

describe("the memory prompt: status, absence and citation discipline", () => {
  it("tells the model the review status is structured data, to put it inside the cited sentence, never as its own item, and never to imply the page says it", () => {
    assert.match(MEMORY_PROMPT, /Review status: each record carries a "review" field\. It is structured data returned by the tool, NOT text on the page/);
    assert.match(MEMORY_PROMPT, /State a status only when the record's review field says it, and never imply the page itself says it/);
    assert.match(MEMORY_PROMPT, /Put the status INSIDE the same sentence as the page-backed statement/);
    assert.match(MEMORY_PROMPT, /\(record status: proposed, not yet approved\)/);
    assert.match(MEMORY_PROMPT, /Never write the status as a separate sentence or item/);
    assert.match(MEMORY_PROMPT, /discards the WHOLE answer/);
  });
  it("tells the model to use the coverage form for missing information, to say 'not found in the retrieved notes' and never 'does not exist'", () => {
    assert.match(MEMORY_PROMPT, /Missing information and absence: say what the retrieved notes do not show only in the short coverage form/);
    assert.match(MEMORY_PROMPT, /"not found in the retrieved notes", never "does not exist"/);
    assert.match(MEMORY_PROMPT, /do not claim that something does not exist, that nobody is assigned, or that no link exists/);
    assert.match(MEMORY_PROMPT, /instead of asserting it/);
  });
  it("tells the model every other factual item cites a delivered segment, to combine related claims into one item, and never to invent ids or put ids in the text", () => {
    assert.match(MEMORY_PROMPT, /Citation discipline: every other factual item cites at least one segment id that appeared in a tool result/);
    assert.match(MEMORY_PROMPT, /the id goes in cites, never in the text; never invent an id/);
    assert.match(MEMORY_PROMPT, /Combine closely related claims that the same segment supports into ONE item with ONE factual sentence/);
  });
  it("its own example carries the segment id only in cites (a marker in the text would be rejected), and the example shape is accepted by the validator", async () => {
    assert.doesNotMatch(MEMORY_PROMPT, /\[M\d+\.S\d+\]/, "no bracketed marker is taught");
    assert.equal(await verdict([item("Dana from Operations will confirm the warehouse slot (record status: proposed, not yet approved).", ["M1.S2"])]), "answered");
  });
  it("the earlier instructions it replaced are gone, and the rest of the memory prompt is intact", () => {
    assert.doesNotMatch(MEMORY_PROMPT, /say so \("proposed, not yet reviewed"\) when you state it/);
    assert.match(MEMORY_PROMPT, /Choosing the first tool/);
    assert.match(MEMORY_PROMPT, /A relationship shows its basis/);
    assert.match(MEMORY_PROMPT, /A record shows a "cites" list/);
  });
});

describe("the validator is unchanged: the prescribed shapes pass, the old shapes still fail", () => {
  it("a combined cited sentence with the structured proposed status passes", async () => {
    assert.equal(await verdict([item("Dana from Operations will confirm the warehouse slot (record status: proposed, not yet approved).", ["M1.S2"])]), "answered");
  });
  it("a separate uncited factual status sentence is still rejected (all or nothing), even next to a valid cited item", async () => {
    assert.equal(await verdict([item(cited, ["M1.S2"]), item("This record is proposed and has not been reviewed yet.", [])]), "declined:uncited");
    assert.equal(await verdict([item(cited, ["M1.S2"]), item("The record status is proposed, not yet approved.", [])]), "declined:uncited");
  });
  it("absence in the coverage form passes next to a cited item; unsupported absence claims are still rejected", async () => {
    for (const s of ["The retrieved notes do not mention Halcyon.", "The notes do not state a due date."]) {
      assert.ok(isCoverageStatement(s), s);
      assert.equal(await verdict([item("Dana from Operations will confirm the warehouse slot (record status: proposed, not yet approved).", ["M1.S2"]), item(s, [])]), "answered", s);
    }
    for (const s of ["No stored record links this slot to Halcyon.", "Nobody else is assigned to this warehouse task.", "The Halcyon project does not exist in the company notes."]) {
      assert.equal(await verdict([item(cited, ["M1.S2"]), item(s, [])]), "declined:uncited", s);
    }
  });
  it("invalid, undelivered and invented citations are still rejected", async () => {
    for (const c of ["M1.S1", "S2", "M2.S2", "M9.S9", "M1.S2.extra", "M1.S02x"]) assert.equal(await verdict([item(cited, [c])]), "declined:uncited", c);
  });
  it("a segment id written into the text is still rejected, and two factual sentences in one item are still rejected", async () => {
    assert.equal(await verdict([item(`${cited} [M1.S2]`, ["M1.S2"])]), "declined:uncited");
    assert.equal(await verdict([item(`${cited} It is a proposed record, not yet approved by anyone.`, ["M1.S2"])]), "declined:uncited");
  });
  it("the tool-call limits are unchanged", () => {
    assert.equal(MAX_ROUNDS, 3);
    assert.equal(MAX_CALLS, 4);
  });
});
