import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { BrainChatContext } from "../src/lib/ai-brain/chat";
import { runBrainTool, unavailableConnectors } from "../src/lib/ai-brain/assistant";
import type { NotionConnector } from "../src/lib/ai-brain/assistant";
import type { MeetingCandidate, MeetingDocument } from "../src/lib/ai-brain/assistant/meetings/types";
import {
  RELATION_TYPES, createMemoryOrgStore, entityRefs, runIngestion, validateRelationships,
  type Extractor, type RelationshipExtractor,
} from "../src/lib/ai-brain/org-memory";
import { createSupabaseOrgMemory } from "../src/lib/backend/supabase/org-memory";
import { UserFacingError } from "../src/lib/backend/types";
import { NOW, admin, fakeRepo } from "./ai-chat-helpers";
import { ADMIN } from "./precon-helpers";

/** Phase 2B remediation (local only): all 12 relation types, stale approval, empty extraction, history in lists. Migration 0014 is PROPOSED and NOT APPLIED. */

const TITLE = "Weekly sync";
function notion(lines: string[], edited = "2026-10-20T10:00:00.000Z"): NotionConnector {
  return {
    ...unavailableConnectors().notion,
    async findMeetingCandidates() { return { ok: true, data: [{ system: "notion", record_id: "p1", title: TITLE, url: "https://www.notion.so/p1", last_edited: edited, date_only: false, date_source: "none", retrieved_at: NOW.toISOString() } as MeetingCandidate] }; },
    async readMeetingDocument(id) {
      const segments = [TITLE, ...lines].map((t, i) => ({ id: `S${i + 1}`, ref: `b${i}`, kind: i === 0 ? ("title" as const) : ("text" as const), text: t, depth: 0 }));
      return { ok: true, data: { system: "notion", record_id: id, title: TITLE, url: "https://www.notion.so/p1", last_edited: edited, date_only: false, date_source: "none", retrieved_at: NOW.toISOString(), segments, coverage: { complete: true, gaps: [], blocks_read: segments.length } } as MeetingDocument };
    },
  };
}
const brainFor = (reader: ReturnType<ReturnType<typeof createMemoryOrgStore>["readerFor"]>): BrainChatContext =>
  ({ user: admin, repo: fakeRepo({}).repo, mode: "live", now: NOW, orgMemory: reader, connectors: unavailableConnectors() });

// ---------------------------------------------------------------------------------------------------------------- 12 types
const LINE = "Priya and Platform: Kickoff meeting, Pune launch decision, Ship task, Review action, Vendor commitment, Friday deadline, Slip risk, Vendor blocker, Halcyon project, Audit requirement.";
const TYPED = [
  { entity_type: "person", name: "Priya" }, { entity_type: "team", name: "Platform" }, { entity_type: "project", name: "Halcyon project" }, { entity_type: "meeting", name: "Kickoff meeting" },
  { entity_type: "decision", name: "Pune launch decision" }, { entity_type: "task", name: "Ship task" }, { entity_type: "action_item", name: "Review action" }, { entity_type: "commitment", name: "Vendor commitment" },
  { entity_type: "deadline", name: "Friday deadline" }, { entity_type: "risk", name: "Slip risk" }, { entity_type: "blocker", name: "Vendor blocker" }, { entity_type: "client_requirement", name: "Audit requirement" },
].map((e) => ({ ...e, description: `${e.name} is named in the notes.`, evidence: ["S2"], basis: "explicit", confidence: "high" }));
const typedExtractor: Extractor = { async extract() { return { ok: true, raw: TYPED, truncated: false }; } };
const NAME_OF: Record<string, string> = Object.fromEntries(TYPED.map((e) => [e.entity_type, e.name]));
type RType = (typeof RELATION_TYPES)[number];
/** Written out by hand (not derived from the rules under test): a pair each relation accepts and a pair it must refuse. RELATES_TO accepts anything but a self link. */
const PAIRS: [RType, string, string, string, string][] = [
  ["OWNS", "person", "project", "project", "person"],
  ["ASSIGNED_TO", "task", "person", "person", "task"],
  ["COMMITTED_TO", "person", "task", "task", "person"],
  ["BELONGS_TO", "task", "project", "project", "task"],
  ["PART_OF", "task", "project", "person", "project"],
  ["RESULTED_IN", "meeting", "decision", "person", "decision"],
  ["DISCUSSED_IN", "decision", "meeting", "meeting", "decision"],
  ["RAISED_IN", "risk", "meeting", "meeting", "risk"],
  ["BLOCKS", "blocker", "task", "person", "task"],
  ["DEPENDS_ON", "task", "project", "risk", "task"],
  ["HAS_DEADLINE", "task", "deadline", "deadline", "task"],
  ["RELATES_TO", "person", "project", "project", "project"],
];

async function typedWorld(links: (ref: (name: string) => string) => unknown[]) {
  const store = createMemoryOrgStore(() => NOW);
  const relEx: RelationshipExtractor = { async extract(_d, entities) { const refs = entityRefs(entities); const ref = (n: string) => [...refs].find(([, e]) => e.name === n)?.[0] ?? "E999"; return { ok: true, raw: links(ref), truncated: false }; } };
  const report = await runIngestion({ notion: notion([LINE]), writer: store.writer, extractor: typedExtractor, relationshipExtractor: relEx }, { workspaceId: "ws-1", now: () => NOW });
  return { store, report, reader: store.readerFor(admin) };
}

describe("all 12 relation types end to end, with valid and invalid endpoint combinations", () => {
  it("the table covers exactly the 12 approved types", () => {
    assert.deepEqual(PAIRS.map((p) => p[0]).sort(), [...RELATION_TYPES].sort());
  });
  for (const [type, fromT, toT, badFromT, badToT] of PAIRS) {
    it(`${type}: ${fromT} -> ${toT} is stored (proposed, findable); ${badFromT} -> ${badToT} is refused`, async () => {
      const good = { relation_type: type, evidence: ["S2"], basis: "explicit", confidence: "high" };
      const w = await typedWorld((ref) => [
        { ...good, from: ref(NAME_OF[fromT]!), to: ref(NAME_OF[toT]!) },
        { ...good, from: ref(NAME_OF[badFromT]!), to: ref(NAME_OF[badToT]!) },
      ]);
      assert.equal(w.report.relationships_created, 1, "only the valid pair is stored");
      assert.equal(w.report.relationships_rejected, 1);
      const found = await w.reader.findRelationships({ relation_type: type, limit: 10 });
      assert.equal(found.length, 1);
      assert.deepEqual([found[0]!.from.name, found[0]!.to.name, found[0]!.review_status, found[0]!.basis, found[0]!.stale], [NAME_OF[fromT], NAME_OF[toT], "proposed", "explicit", false]);
      // the refusal reason, asked of the validator directly
      const snap = w.store.snapshot();
      const refs = entityRefs(snap.entities);
      const ref = (n: string) => [...refs].find(([, e]) => e.name === n)![0];
      const v = validateRelationships(snap.docs[0]!, snap.entities, [{ ...good, from: ref(NAME_OF[badFromT]!), to: ref(NAME_OF[badToT]!) }]);
      assert.deepEqual(v.reasons, { [badFromT === badToT ? "self" : "type_mismatch"]: 1 });
      // and through the Registry tool, filtered by this type
      const r = await runBrainTool(brainFor(w.reader), "memory.relationships.find", { relation_type: type });
      assert.ok(r.ok && r.records.length === 1 && r.records[0]!.title.includes(` ${type} `));
    });
  }
  it("all 12 types stored together are each returned only for their own type", async () => {
    const w = await typedWorld((ref) => PAIRS.map(([type, f, t]) => ({ relation_type: type, from: ref(NAME_OF[f]!), to: ref(NAME_OF[t]!), evidence: ["S2"], basis: "explicit", confidence: "high" })));
    assert.equal(w.report.relationships_created, 12);
    for (const [type] of PAIRS) assert.equal((await w.reader.findRelationships({ relation_type: type, limit: 25 })).length, 1, type);
  });
});

// ---------------------------------------------------------------------------------------------------------------- stale + empty
const LINES = ["Priya will send the checklist by Friday.", "Decision: launch the marketplace in Pune first.", "Vendor onboarding may slip."];
const ENTITIES = [
  { entity_type: "person", name: "Priya", description: "Priya sends the checklist.", evidence: ["S2"], basis: "explicit", confidence: "high" },
  { entity_type: "task", name: "Send checklist", description: "Priya sends the checklist.", evidence: ["S2"], basis: "explicit", confidence: "high", owner: "Priya", due: "Friday" },
  { entity_type: "decision", name: "Launch in Pune", description: "Launch the marketplace in Pune first.", evidence: ["S3"], basis: "explicit", confidence: "high" },
  { entity_type: "risk", name: "Vendor onboarding slip", description: "Vendor onboarding may slip.", evidence: ["S4"], basis: "extracted", confidence: "medium" },
];
const entityExtractor: Extractor = { async extract() { return { ok: true, raw: ENTITIES, truncated: false }; } };
type Link = { from: string; to: string; relation_type: string; evidence: string[]; basis: string; confidence: string };
const ASSIGNED: Link = { from: "Send checklist", to: "Priya", relation_type: "ASSIGNED_TO", evidence: ["S2"], basis: "explicit", confidence: "high" };
const RESULT: Link = { from: "Launch in Pune", to: "Vendor onboarding slip", relation_type: "RELATES_TO", evidence: ["S3", "S4"], basis: "inferred", confidence: "medium" };
const relExtractor = (links: Link[]): RelationshipExtractor => ({
  async extract(_d, entities) { const refs = entityRefs(entities); const ref = (n: string) => [...refs].find(([, e]) => e.name === n)?.[0] ?? "E999"; return { ok: true, raw: links.map((l) => ({ ...l, from: ref(l.from), to: ref(l.to) })), truncated: false }; },
});
async function ingested() {
  const store = createMemoryOrgStore(() => NOW);
  await runIngestion({ notion: notion(LINES), writer: store.writer, extractor: entityExtractor, relationshipExtractor: relExtractor([ASSIGNED, RESULT]) }, { workspaceId: "ws-1", now: () => NOW });
  return { store, reader: store.readerFor(admin) };
}
const keepOnly = (r: { relation_type: RType; from_entity_id: string; to_entity_id: string; evidence: string[]; basis: "explicit" | "extracted" | "inferred"; confidence: "high" | "medium" | "low" }) =>
  ({ relation_type: r.relation_type, from_entity_id: r.from_entity_id, to_entity_id: r.to_entity_id, evidence: r.evidence, basis: r.basis, confidence: r.confidence });

describe("stale and empty-extraction protection", () => {
  it("a stale PROPOSED relationship cannot be approved (it can still be rejected); a current one can", async () => {
    const { store, reader } = await ingested();
    const all = store.snapshot().relationships;
    const first = all.find((r) => r.basis === "explicit")!;
    const second = all.find((r) => r.id !== first.id)!;
    // the document re-states only `second`: `first` is no longer stated and goes stale
    await store.writer.upsertRelationships(first.source_doc_id, [keepOnly(second)], NOW.toISOString());
    assert.equal(store.snapshot().relationships.find((r) => r.id === first.id)!.stale, true);
    await assert.rejects(() => reader.reviewRelationship(first.id, "approve", "ok"), /stale/);
    assert.equal(store.snapshot().relationships.find((r) => r.id === first.id)!.review_status, "proposed");
    assert.equal((await reader.reviewRelationship(first.id, "reject", "outdated")).review_status, "rejected");
    assert.equal((await reader.reviewRelationship(second.id, "approve", "confirmed")).review_status, "reviewed");
  });
  it("an extraction with NO valid link never stales anything, reviewed or not", async () => {
    const { store, reader } = await ingested();
    const rel = store.snapshot().relationships.find((r) => r.basis === "explicit")!;
    await reader.reviewRelationship(rel.id, "approve", null);
    const res = await store.writer.upsertRelationships(rel.source_doc_id, [], NOW.toISOString());
    assert.deepEqual([res.staled, res.created], [0, 0]);
    assert.ok(store.snapshot().relationships.every((r) => !r.stale), "nothing went stale");
  });
  it("through ingestion: a changed document whose relationship answer is all invalid (or empty) leaves a reviewed link untouched", async () => {
    for (const answer of [[{ bogus: true }, { from: "E1", to: "E2" }], []] as unknown[][]) {
      const { store, reader } = await ingested();
      const rel = store.snapshot().relationships.find((r) => r.basis === "explicit")!;
      await reader.reviewRelationship(rel.id, "approve", null);
      const next = await runIngestion({ notion: notion([LINES[0]!, LINES[1]!, "Vendor onboarding is on track."], "2026-10-21T10:00:00.000Z"), writer: store.writer, extractor: entityExtractor, relationshipExtractor: { async extract() { return { ok: true, raw: answer, truncated: false }; } } }, { workspaceId: "ws-1", now: () => NOW });
      assert.equal(next.changed, 1, "the document really changed and was re-extracted");
      assert.deepEqual([next.relationships_staled, next.relationships_created], [0, 0]);
      const after = store.snapshot().relationships.find((r) => r.id === rel.id)!;
      assert.deepEqual([after.review_status, after.stale, after.pending_revision], ["reviewed", false, null]);
    }
  });
  it("a partial answer still stales the links the document no longer states (only an EMPTY result is ignored)", async () => {
    const { store } = await ingested();
    const [a, b] = store.snapshot().relationships;
    const res = await store.writer.upsertRelationships(a!.source_doc_id, [keepOnly(a!)], NOW.toISOString());
    assert.equal(res.staled, 1);
    assert.equal(store.snapshot().relationships.find((r) => r.id === b!.id)!.stale, true);
  });
});

// ---------------------------------------------------------------------------------------------------------------- history in lists
interface Call { table?: string; rpc?: string; args?: Record<string, unknown>; ops: [string, unknown[]][] }
function stub(results: Record<string, unknown> = {}) {
  const calls: Call[] = [];
  const builder = (call: Call, key: string) => {
    const b: unknown = new Proxy({}, {
      get(_t, prop: string) {
        if (prop === "then") return (ok: (v: unknown) => void) => ok({ data: key in results ? results[key] : [], error: null });
        return (...args: unknown[]) => { call.ops.push([prop, args]); return b; };
      },
    });
    return b;
  };
  const db = {
    from(table: string) { const c: Call = { table, ops: [] }; calls.push(c); return builder(c, table); },
    rpc(name: string, args?: Record<string, unknown>) { const c: Call = { rpc: name, args, ops: [] }; calls.push(c); return builder(c, name); },
  } as unknown as SupabaseClient;
  return { db, calls };
}
const end = (id: string, type: string, name: string) => ({ id, entity_type: type, name, review_status: "proposed", stale: false, pending_revision: null, source_doc_id: "d1" });
const relRow = (over: Record<string, unknown> = {}) => ({
  id: "r1", stable_id: "abcdef012345", source_doc_id: "d1", from_entity_id: "e1", to_entity_id: "e2", relation_type: "ASSIGNED_TO", evidence: ["S2"], basis: "explicit", confidence: "high",
  extracted_at: "2026-10-25T12:00:00+00:00", review_status: "proposed", stale: false, pending_revision: null, doc: { archived: false },
  from: end("e1", "task", "Send checklist"), to: end("e2", "person", "Priya"), ...over,
});

describe("history is the same in lists and queues as in a single read", () => {
  it("in-memory: find, get and queue all carry approve and accept_revision", async () => {
    const { store, reader } = await ingested();
    const rel = store.snapshot().relationships.find((r) => r.basis === "explicit")!;
    await reader.reviewRelationship(rel.id, "approve", null);
    await store.writer.upsertRelationships(rel.source_doc_id, [{ ...keepOnly(rel), basis: "extracted", confidence: "medium" }], NOW.toISOString());
    const inQueue = (await reader.listRelationshipQueue(10)).find((r) => r.id === rel.id)!;
    assert.deepEqual(inQueue.history.map((h) => h.action), ["approve"]);
    await reader.reviewRelationship(rel.id, "accept_revision", null);
    const fromFind = (await reader.findRelationships({ relation_type: rel.relation_type, limit: 10 }))[0]!;
    const fromGet = (await reader.getRelationship(rel.id))!;
    assert.deepEqual(fromFind.history.map((h) => h.action), ["approve", "accept_revision"]);
    assert.deepEqual(fromGet.history, fromFind.history);
  });
  it("Supabase adapter: entity find, entity queue, relationship find and relationship queue all load history (a list used to return [])", async () => {
    const ev = (key: string, id: string, action: string, at: string) => ({ [key]: id, created_at: at, actor_id: "u1", action, note: action === "approve" ? "ok" : null });
    const entRow = { id: "e1", stable_id: "abcdef012345", source_doc_id: "d1", entity_type: "task", name: "Send", description: "d", evidence: ["S2"], basis: "explicit", confidence: "high", owner: null, team: null, due: null, unknowns: [], extracted_at: "2026-10-25T12:00:00+00:00", review_status: "reviewed", stale: false, knowledge_item_id: null, pending_revision: null, doc: { archived: false } };
    const s = stub({
      org_entities: [entRow], org_relationships: [relRow({ review_status: "reviewed" })],
      org_entity_events: [ev("entity_id", "e1", "approve", "2026-10-26T10:00:00+00:00"), ev("entity_id", "e1", "accept_revision", "2026-10-27T10:00:00+00:00"), ev("entity_id", "other", "reject", "2026-10-27T10:00:00+00:00")],
      org_relationship_events: [ev("relationship_id", "r1", "approve", "2026-10-26T10:00:00+00:00"), ev("relationship_id", "r1", "accept_revision", "2026-10-27T10:00:00+00:00"), { relationship_id: "r1", created_at: "2026-10-28T10:00:00+00:00", actor_id: null, action: "weird", note: null }],
    });
    const { reader } = createSupabaseOrgMemory(s.db, ADMIN);
    assert.deepEqual((await reader.findEntities({ limit: 5 }))[0]!.history.map((h) => h.action), ["approve", "accept_revision"]);
    assert.deepEqual((await reader.listReviewQueue(5))[0]!.history.map((h) => h.action), ["approve", "accept_revision"]);
    const rel = (await reader.findRelationships({ limit: 5 }))[0]!;
    assert.deepEqual(rel.history.map((h) => [h.action, h.by, h.note]), [["approve", "u1", "ok"], ["accept_revision", "u1", null]], "unknown actions are dropped");
    assert.deepEqual((await reader.listRelationshipQueue(5))[0]!.history.map((h) => h.action), ["approve", "accept_revision"]);
    const eventCalls = s.calls.filter((c) => c.table === "org_relationship_events" || c.table === "org_entity_events");
    assert.ok(eventCalls.length >= 4 && eventCalls.every((c) => c.ops.some(([o]) => o === "in")), "history is fetched with one batched query per list, never one per row");
  });
});

describe("Supabase adapter: stale approval and empty extraction", () => {
  it("approving a stale relationship is refused before the approve function is called; reject and accept_revision still go through", async () => {
    const s = stub({ org_relationships: relRow({ stale: true }) });
    const { reader } = createSupabaseOrgMemory(s.db, ADMIN);
    await assert.rejects(() => reader.reviewRelationship("r1", "approve", "ok"), UserFacingError);
    assert.deepEqual(s.calls.filter((c) => c.rpc), [], "no review function was called");
    await reader.reviewRelationship("r1", "reject", null);
    await reader.reviewRelationship("r1", "accept_revision", null);
    assert.deepEqual(s.calls.filter((c) => c.rpc).map((c) => `${c.rpc}:${String(c.args!.p_action)}`), ["org_relationship_review:reject", "org_relationship_review:accept_revision"]);
    const fresh = stub({ org_relationships: relRow({ stale: false }) });
    await createSupabaseOrgMemory(fresh.db, ADMIN).reader.reviewRelationship("r1", "approve", "ok");
    assert.deepEqual(fresh.calls.filter((c) => c.rpc).map((c) => c.rpc), ["org_relationship_review"]);
  });
  it("an empty relationship list never calls stale_missing; a non-empty one does", async () => {
    const s = stub({ org_relationship_upsert: "unchanged", org_relationship_stale_missing: 3 });
    const { writer } = createSupabaseOrgMemory(s.db, ADMIN);
    assert.deepEqual(await writer.upsertRelationships("d1", [], "t"), { created: 0, updated: 0, staled: 0, unchanged: 0, skipped: 0 });
    assert.deepEqual(s.calls.filter((c) => c.rpc), []);
    const out = await writer.upsertRelationships("d1", [{ relation_type: "ASSIGNED_TO", from_entity_id: "e1", to_entity_id: "e2", evidence: ["S2"], basis: "explicit", confidence: "high" }], "t");
    assert.deepEqual(s.calls.filter((c) => c.rpc).map((c) => c.rpc), ["org_relationship_upsert", "org_relationship_stale_missing"]);
    assert.equal(out.staled, 3);
  });
});

// ---------------------------------------------------------------------------------------------------------------- default-off flag
import { askBrain, createMemoryRateLimiter } from "../src/lib/ai-brain/chat";
import { createToolAgent } from "../src/lib/ai-brain/chat/tool-agent";
import { relationshipsEnabled } from "../src/lib/ai-brain/assistant";
import { gateRelationshipTool } from "../src/lib/chat-model";
import type { ToolTransport, ToolTurn } from "../src/lib/ai-brain/model-tool-transport";

describe("relationships are OFF by default (migration 0014 is not applied anywhere)", () => {
  it("relationshipsEnabled is true only for the exact value 1", () => {
    for (const v of [undefined, "", "0", "true", "yes", " 1", "1 "]) assert.equal(relationshipsEnabled({ BROKO_ORG_RELATIONSHIPS: v }), false, String(v));
    assert.equal(relationshipsEnabled({ BROKO_ORG_RELATIONSHIPS: "1" }), true);
  });
  it("the model is not offered memory_relationships_find unless the flag is on; the other memory tools are offered either way", async () => {
    const store = createMemoryOrgStore(() => NOW);
    await runIngestion({ notion: notion(LINES_FOR_FLAG), writer: store.writer, extractor: typedExtractor }, { workspaceId: "ws-1", now: () => NOW });
    const offered = async () => {
      const seen: string[][] = [];
      const transport: ToolTransport = async (req) => { seen.push(req.tools.map((t) => t.name)); return { blocks: [{ type: "text", text: "x" }], stopReason: "end_turn", usage: { input: 1, output: 1 } } satisfies ToolTurn; };
      await askBrain({ user: admin, repo: fakeRepo({}).repo, mode: "live", now: NOW, orgMemory: store.readerFor(admin), connectors: unavailableConnectors(), timeZone: "UTC", toolAgent: gateRelationshipTool(createToolAgent({ transport, limiter: createMemoryRateLimiter({ maxCalls: 50 }) })) }, "what has priya committed to about the checklist");
      return seen[0] ?? [];
    };
    const saved = process.env.BROKO_ORG_RELATIONSHIPS;
    try {
      delete process.env.BROKO_ORG_RELATIONSHIPS;
      const off = await offered();
      assert.ok(off.includes("memory_entities_find") && off.includes("memory_sources_read"));
      assert.ok(!off.includes("memory_relationships_find"), "not offered by default");
      process.env.BROKO_ORG_RELATIONSHIPS = "1";
      assert.ok((await offered()).includes("memory_relationships_find"), "offered when explicitly enabled");
    } finally {
      if (saved === undefined) delete process.env.BROKO_ORG_RELATIONSHIPS; else process.env.BROKO_ORG_RELATIONSHIPS = saved;
    }
  });
  it("the ingestion route only builds a relationship extractor when the flag is on", () => {
    const src = readFileSync(new URL("../src/app/api/org-memory/ingest/route.ts", import.meta.url), "utf8");
    assert.match(src, /transport && relationshipsEnabled\(process\.env\) \? createAnthropicRelationshipExtractor/);
  });
});
const LINES_FOR_FLAG = [LINE];
