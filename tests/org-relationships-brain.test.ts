import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createMemoryRateLimiter, type BrainChatContext } from "../src/lib/ai-brain/chat";
import { createToolAgent } from "../src/lib/ai-brain/chat/tool-agent";
import { memoryTools, runBrainTool, unavailableConnectors } from "../src/lib/ai-brain/assistant";
import type { NotionConnector } from "../src/lib/ai-brain/assistant";
import type { MeetingCandidate, MeetingDocument } from "../src/lib/ai-brain/assistant/meetings/types";
import type { ToolTransport, ToolTurn } from "../src/lib/ai-brain/model-tool-transport";
import { createMemoryOrgStore, entityRefs, runIngestion, type Extractor, type RelationshipExtractor } from "../src/lib/ai-brain/org-memory";
import { NOW, admin, alice, fakeRepo } from "./ai-chat-helpers";

/**
 * Phase 2B, local only (no database, no model): what the MODEL is actually shown for a relationship in each lifecycle state. The earlier Phase 2B tests pin the
 * store, the validator, the adapter and the Registry; these pin the boundary the model sees (review state, basis, confidence, stale flag, citable segments),
 * through the real ingestion, the real in-memory store, the real Registry tool and the real tool agent. Nothing in the validator or the agent is changed.
 */

const LINES = ["Priya will send the checklist by Friday.", "Decision: launch the marketplace in Pune first.", "Vendor onboarding may slip."];
const connector = (lines = LINES, edited = "2026-10-20T10:00:00.000Z"): NotionConnector => ({
  ...unavailableConnectors().notion,
  async findMeetingCandidates() { return { ok: true, data: [{ system: "notion", record_id: "p1", title: "Weekly sync", url: "https://www.notion.so/p1", last_edited: edited, date_only: false, date_source: "none", retrieved_at: NOW.toISOString() } as MeetingCandidate] }; },
  async readMeetingDocument(id) {
    const segments = ["Weekly sync", ...lines].map((t, i) => ({ id: `S${i + 1}`, ref: `b${i}`, kind: i === 0 ? ("title" as const) : ("text" as const), text: t, depth: 0 }));
    return { ok: true, data: { system: "notion", record_id: id, title: "Weekly sync", url: "https://www.notion.so/p1", last_edited: edited, date_only: false, date_source: "none", retrieved_at: NOW.toISOString(), segments, coverage: { complete: true, gaps: [], blocks_read: 4 } } as MeetingDocument };
  },
});
const ENTITIES = [
  { entity_type: "person", name: "Priya", description: "Priya sends the checklist.", evidence: ["S2"], basis: "explicit", confidence: "high" },
  { entity_type: "task", name: "Send checklist", description: "Priya sends the checklist.", evidence: ["S2"], basis: "explicit", confidence: "high", owner: "Priya", due: "Friday" },
  { entity_type: "decision", name: "Launch in Pune", description: "Launch the marketplace in Pune first.", evidence: ["S3"], basis: "explicit", confidence: "high" },
  { entity_type: "risk", name: "Vendor onboarding slip", description: "Vendor onboarding may slip.", evidence: ["S4"], basis: "extracted", confidence: "medium" },
];
const entityExtractor: Extractor = { async extract() { return { ok: true, raw: ENTITIES, truncated: false }; } };
type Link = { from: string; to: string; relation_type: string; evidence: string[]; basis: string; confidence: string };
const relExtractor = (links: () => Link[]): RelationshipExtractor => ({
  async extract(_doc, entities) {
    const refs = entityRefs(entities);
    const ref = (name: string) => [...refs].find(([, e]) => e.name === name)?.[0] ?? "E999";
    return { ok: true, raw: links().map((l) => ({ ...l, from: ref(l.from), to: ref(l.to) })), truncated: false };
  },
});
const ASSIGNED: Link = { from: "Send checklist", to: "Priya", relation_type: "ASSIGNED_TO", evidence: ["S2"], basis: "explicit", confidence: "high" };
const INFERRED: Link = { from: "Launch in Pune", to: "Vendor onboarding slip", relation_type: "RELATES_TO", evidence: ["S3", "S4"], basis: "inferred", confidence: "high" }; // "high" is capped by the validator

async function world(links: Link[] = [ASSIGNED, INFERRED]) {
  const store = createMemoryOrgStore(() => NOW);
  const deps = { notion: connector(), writer: store.writer, extractor: entityExtractor, relationshipExtractor: relExtractor(() => links) };
  await runIngestion(deps, { workspaceId: "ws-1", now: () => NOW });
  return { store, deps };
}
const brainFor = (reader: ReturnType<ReturnType<typeof createMemoryOrgStore>["readerFor"]>, user = admin): BrainChatContext =>
  ({ user, repo: fakeRepo({}).repo, mode: "live", now: NOW, orgMemory: reader, connectors: unavailableConnectors() });

interface Shown { id: string; relation: string; basis: string; confidence: string; review: string; source_changed?: true; cites: string[]; page: string | null }
/** Runs the real tool agent against the store and returns the relationships exactly as the model was shown them, plus the verdict for a given citation. */
async function modelView(store: ReturnType<typeof createMemoryOrgStore>, input: Record<string, unknown>, cite = "M1.S2", user = admin) {
  const turn = (name: string, i: unknown): ToolTurn => ({ blocks: [{ type: "tool_use", id: `${name}1`, name, input: i }], stopReason: "tool_use", usage: { input: 1, output: 1 } });
  const turns = [turn("memory_relationships_find", input), turn("submit_answer", { items: [{ text: "Priya is assigned to send the checklist.", cites: [cite] }] })];
  const requests: string[] = [];
  let n = 0;
  const transport: ToolTransport = async (req) => { requests.push(JSON.stringify(req)); return turns[Math.min(n++, turns.length - 1)]!; };
  const out = await createToolAgent({ transport, limiter: createMemoryRateLimiter({ maxCalls: 50 }) }).run({
    userId: user.id, role: user.role === "admin" ? "admin" : "member", message: "who is assigned the checklist", today: "Sunday 25 October 2026", timeZone: "UTC", recent: [],
    contracts: memoryTools(), run: (id, i) => runBrainTool(brainFor(store.readerFor(user), user), id, i),
  });
  // The second request carries the tool result: pull the fenced JSON out of the (escaped) request text.
  const body = requests[1] ? (JSON.parse(requests[1]) as { messages: { content: unknown }[] }).messages.flatMap((m) => (Array.isArray(m.content) ? m.content : [])) : [];
  const result = body.map((b) => (b as { content?: unknown }).content).find((c) => typeof c === "string" && c.includes("relationships")) as string | undefined;
  const json = result ? /\n(\{[\s\S]*\})\n/.exec(result)?.[1] : undefined;
  const shown = json ? (JSON.parse(json) as { relationships: Shown[]; segments: string[] }) : { relationships: [] as Shown[], segments: [] as string[] };
  return { out, shown, requests };
}
const byRelation = (v: { relationships: Shown[] }, type: string) => v.relationships.find((r) => r.relation === type);

describe("the model sees each relationship's review state, basis and confidence, and cites only current evidence", () => {
  it("a new link is PROPOSED and carries its basis; an explicit link is citable; an inferred link is labelled inferred and never high confidence", async () => {
    const { store } = await world();
    const v = await modelView(store, {});
    const explicit = byRelation(v.shown, "ASSIGNED_TO")!;
    assert.deepEqual([explicit.review, explicit.basis, explicit.confidence], ["proposed", "explicit", "high"]);
    assert.deepEqual(explicit.cites, ["M1.S2"]);
    const inferred = byRelation(v.shown, "RELATES_TO")!;
    assert.deepEqual([inferred.review, inferred.basis], ["proposed", "inferred"]);
    assert.notEqual(inferred.confidence, "high", "an inference is capped below high before it is ever stored");
    assert.equal(v.out.kind, "answered");
  });
  it("after a person approves it the model is shown it as reviewed (the state is read from the store, not from model text)", async () => {
    const { store } = await world();
    const reader = store.readerFor(admin);
    const id = (await reader.findRelationships({ relation_type: "ASSIGNED_TO", limit: 5 }))[0]!.id;
    await reader.reviewRelationship(id, "approve", null);
    const v = await modelView(store, { relation_type: "ASSIGNED_TO" });
    assert.equal(byRelation(v.shown, "ASSIGNED_TO")!.review, "reviewed");
  });
  it("a rejected link is never shown to the model, and re-ingesting the same document does not bring it back", async () => {
    const { store, deps } = await world();
    const reader = store.readerFor(admin);
    const id = (await reader.findRelationships({ relation_type: "ASSIGNED_TO", limit: 5 }))[0]!.id;
    await reader.reviewRelationship(id, "reject", null);
    assert.equal(byRelation((await modelView(store, {})).shown, "ASSIGNED_TO"), undefined);
    // Same content hash: nothing to extract. Force a re-extraction path with an edited document so the extractor runs again and proposes the same link.
    const edited = { ...deps, notion: connector([...LINES, "An extra note."], "2026-10-21T10:00:00.000Z") };
    assert.equal((await runIngestion(edited, { workspaceId: "ws-1", now: () => NOW })).extracted_docs, 1, "the edited document really was re-extracted");
    assert.equal(byRelation((await modelView(store, {})).shown, "ASSIGNED_TO"), undefined, "a rejected link stays rejected");
    assert.equal(store.snapshot().relationships.find((r) => r.relation_type === "ASSIGNED_TO")!.review_status, "rejected");
  });
  it("a reviewed link whose source changed is shown as source_changed with NO citable segment, so the model cannot cite it as current", async () => {
    const { store, deps } = await world();
    const reader = store.readerFor(admin);
    const id = (await reader.findRelationships({ relation_type: "ASSIGNED_TO", limit: 5 }))[0]!.id;
    await reader.reviewRelationship(id, "approve", null);
    // The new extraction supports the link differently (different evidence): a reviewed link is parked as a pending revision, not overwritten.
    const changed = { ...deps, notion: connector([...LINES, "Priya confirmed it again."], "2026-10-21T10:00:00.000Z"), relationshipExtractor: relExtractor(() => [{ ...ASSIGNED, evidence: ["S2", "S5"] }, INFERRED]) };
    assert.equal((await runIngestion(changed, { workspaceId: "ws-1", now: () => NOW })).extracted_docs, 1, "the edited document really was re-extracted");
    const v = await modelView(store, { relation_type: "ASSIGNED_TO" });
    const shown = byRelation(v.shown, "ASSIGNED_TO")!;
    assert.equal(shown.source_changed, true);
    assert.equal(shown.review, "reviewed", "the earlier review is preserved, not overwritten");
    assert.deepEqual(shown.cites, []);
    assert.equal(shown.page, null);
    assert.equal(v.out.kind, "declined", "citing a changed link is refused: no segment of it was delivered");
  });
  it("a link the document no longer states is shown as source_changed with no citable segment (it is not a current fact)", async () => {
    const { store, deps } = await world();
    // A non-empty answer that omits the link: the link goes stale (an EMPTY answer proves nothing and stales nothing; see the remediation tests).
    const later = { ...deps, notion: connector([...LINES, "Another line."], "2026-10-21T10:00:00.000Z"), relationshipExtractor: relExtractor(() => [INFERRED]) };
    assert.equal((await runIngestion(later, { workspaceId: "ws-1", now: () => NOW })).extracted_docs, 1, "the edited document really was re-extracted");
    const v = await modelView(store, { relation_type: "ASSIGNED_TO" });
    const shown = byRelation(v.shown, "ASSIGNED_TO");
    assert.ok(shown, "a link the document stopped stating is still listed, but flagged");
    assert.equal(shown.source_changed, true);
    assert.deepEqual(shown.cites, []);
    assert.equal(shown.page, null);
    assert.equal(v.out.kind, "declined", "it cannot be cited as a current fact");
  });
});

describe("authorization at the model boundary", () => {
  it("a member's tool call returns nothing from the store and the answer cannot be grounded; the administrator's can", async () => {
    const { store } = await world();
    const asMember = await modelView(store, {}, "M1.S2", alice);
    assert.equal(asMember.shown.relationships.length, 0);
    assert.notEqual(asMember.out.kind, "answered");
    const asAdmin = await modelView(store, {});
    assert.ok(asAdmin.shown.relationships.length >= 1);
    assert.equal(asAdmin.out.kind, "answered");
  });
  it("the model cannot widen the query: unknown fields and a bad entity id or type are refused before the store is read", async () => {
    const { store } = await world();
    for (const bad of [{ include_rejected: true }, { entity_id: "not-a-uuid" }, { relation_type: "KNOWS" }, { limit: 500 }]) {
      const v = await modelView(store, bad);
      assert.equal(v.shown.relationships.length, 0, JSON.stringify(bad));
    }
  });
});

describe("history is preserved across review", () => {
  it("approve then a changed extraction then accept keeps every event, newest last, and the id never changes", async () => {
    const { store, deps } = await world();
    const reader = store.readerFor(admin);
    const first = (await reader.findRelationships({ relation_type: "ASSIGNED_TO", limit: 5 }))[0]!;
    await reader.reviewRelationship(first.id, "approve", null);
    assert.equal((await runIngestion({ ...deps, notion: connector([...LINES, "Priya confirmed it again."], "2026-10-21T10:00:00.000Z"), relationshipExtractor: relExtractor(() => [{ ...ASSIGNED, evidence: ["S2", "S5"] }, INFERRED]) }, { workspaceId: "ws-1", now: () => NOW })).extracted_docs, 1);
    await reader.reviewRelationship(first.id, "accept_revision", null);
    const after = (await reader.findRelationships({ relation_type: "ASSIGNED_TO", limit: 5 }))[0]!;
    assert.equal(after.id, first.id, "stable identity");
    assert.deepEqual(after.history.map((h) => h.action), ["approve", "accept_revision"]);
    assert.equal(after.review_status, "reviewed");
    assert.deepEqual(after.evidence, ["S2", "S5"]);
  });
});
